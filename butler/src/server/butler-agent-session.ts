import { promises as fs } from "node:fs";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  BUTLER_BACKGROUND_PROMPT_PREFIX,
  BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX,
  buildLatestProofMap,
  buildProofsByThreadMap,
  buildMessagePage,
  buildSystemPrompt,
  collapseCallbackDuplicateMessages,
  isAssistantFailureMessage,
  MAX_HISTORY_PAGE_SIZE,
  mergeVisibleMessages,
  sanitizeHistoryMessage,
  sanitizeHistoryMessages,
  serializeMessages,
  SNAPSHOT_MESSAGE_TAIL_LIMIT
} from "./butler-agent-helpers.js";
import type { ButlerAgentSessionAccess } from "./butler-agent-tool-access.js";
import { readButlerAuthStatus } from "./auth-status.js";
import { finalizeButlerActivityTurn, getButlerActivityTurns, recordButlerActivityEvent } from "./butler-activity.js";
import { backfillOperatorMessagesFromSessionFiles, isPersistableProviderOperatorMessage, removeTrivialOperatorQuestionConfirmations, upsertProviderBackedOperatorMessage } from "./butler-operator-messages.js";
import { PiProviderRuntimeMapper } from "./pi-provider-events.js";
import { getActiveManorSettings, isSecretSourceAvailable } from "./manor-settings-runtime.js";
import { createManorModelRegistry, formatProviderModelRef, modelToModelOption, parseProviderModelRef, shouldExposeManorModel } from "./model-provider-config.js";
import { isChatGptSubscriptionModelAvailable, isOpenAiRuntimeProvider } from "./chatgpt-entitlement.js";
import { syncProviderWebToolsForSession } from "./provider-web-tools.js";
import { displayThinkingLevelForModelOption, piThinkingLevelForModelOption } from "./pi-thinking-levels.js";
import { applyOpencodeGoNativeThinkingPayload } from "./pi-opencode-web-tools-extension.js";
import { syncVisionToolForSession } from "./butler-agent-vision-tools.js";
import type {
  AppShellSnapshot,
  AppSnapshot,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerLiveSnapshot,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerTraceItemView,
  ButlerThinkingLevel
} from "./types.js";

const MAX_PENDING_OPERATOR_MESSAGES = 20;

function fallbackThinkingLevel(levels: readonly ButlerThinkingLevel[], defaultReasoningEffort: ButlerThinkingLevel | null | undefined): ButlerThinkingLevel {
  return defaultReasoningEffort ?? levels[0] ?? "off";
}

function registerOpencodeGoRequestTransforms(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => applyOpencodeGoNativeThinkingPayload(event.payload));
}

function activityTraceItems(turn: ReturnType<typeof getButlerActivityTurns>[number]): ButlerTraceItemView[] {
  return turn.items.map((item) => ({
    id: item.id,
    type: item.kind === "thinking" ? "reasoning" : "dynamic_tool_call",
    status: item.status === "active" ? "in_progress" : item.status === "error" ? "failed" : item.status === "stopped" ? "declined" : "completed",
    text: item.text,
    title: item.title,
    at: item.at,
    completedAt: item.status === "active" ? null : item.updatedAt
  }));
}

export function attachCompletedActivityTraceToDelegationAcknowledgement(access: ButlerAgentSessionAccess): boolean {
  const turn = [...getButlerActivityTurns(access)].reverse().find((entry) => entry.status !== "active" && entry.items.length > 0);
  if (!turn) return false;
  const acknowledgement = [...access.operatorMessages].reverse().find((message) =>
    message.id.startsWith("delegation-ack-") &&
    (message.at ?? 0) >= turn.startedAt &&
    (message.at ?? 0) <= (turn.completedAt ?? Number.POSITIVE_INFINITY));
  if (!acknowledgement || acknowledgement.trace?.length) return false;
  const trace = activityTraceItems(turn);
  acknowledgement.trace = trace;
  acknowledgement.traceMeta = {
    turnId: turn.id,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt ?? turn.startedAt,
    items: trace
  };
  return true;
}

export async function createOrRefreshButlerSession(access: ButlerAgentSessionAccess): Promise<void> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  access.unsubscribeSession?.();
  access.unsubscribeSession = null;

  if (access.session) {
    await access.session.abort().catch(() => {});
    access.session.dispose();
    access.session = null;
  }

  await sanitizePersistedButlerSessions(access);

  const authStorage = AuthStorage.create(access.piAuthPath);
  const resourceLoader = new DefaultResourceLoader({
    cwd: "/repos",
    agentDir: path.dirname(access.piAuthPath),
    extensionFactories: [registerOpencodeGoRequestTransforms],
    systemPromptOverride: () => [buildSystemPrompt(access.store, access.describePendingCallbacks()), access.systemPromptSuffix].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();

  access.session = (
    await createAgentSession({
      cwd: "/repos",
      authStorage,
      modelRegistry: access.modelRegistry,
      noTools: "builtin",
      customTools: access.buildCustomTools(),
      sessionManager: SessionManager.continueRecent("/repos", access.sessionDir),
      resourceLoader
    })
  ).session;

  sanitizeButlerSessionMessages(access);
  dropTrailingFailedButlerTurns(access);
  await applyManagedButlerDefaults(access);
  if (access.session) { syncVisionToolForSession(access.session); await syncProviderWebToolsForSession(access.session); }

  access.compaction = {
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastTokensBefore: null,
    lastWillRetry: false,
    lastAborted: false,
    lastError: null
  };
  restoreButlerCompactionState(access);

  const runtimeMapper = new PiProviderRuntimeMapper(access.runtimeThreadId);
  const traceBuffer = access.traceBuffer;
  if (typeof traceBuffer.reset === "function") {
    traceBuffer.reset();
  }
  access.unsubscribeSession = access.session.subscribe((event) => {
    recordButlerActivityEvent(access, event);
    let operatorMessageChanged = event.type === "agent_end"
      ? attachCompletedActivityTraceToDelegationAcknowledgement(access)
      : false;
    const patches = runtimeMapper.map(event, access.session!);
    for (const patch of patches) {
      if (patch.kind === "turn-lifecycle" && patch.status === "started") {
        traceBuffer.startTurn(patch.turnId, patch.at);
      }
      if (patch.kind === "item-lifecycle" && patch.itemId) {
        if (patch.itemType === "assistant_message") {
          traceBuffer.setAssistantItem(patch.turnId, patch.itemId, patch.at);
        } else if (patch.itemType !== "user_message") {
          traceBuffer.upsertItem({
            turnId: patch.turnId,
            itemId: patch.itemId,
            type: patch.itemType,
            status: patch.status,
            text: patch.text,
            ...(patch.title ? { title: patch.title } : {}),
            at: patch.at,
            ...(patch.status === "completed" ? { completedAt: patch.at } : {})
          });
        }
      }
      if (patch.kind === "content-delta" && patch.itemId && patch.itemType !== "assistant_message" && patch.itemType !== "user_message") {
        traceBuffer.upsertItem({
          turnId: patch.turnId,
          itemId: patch.itemId,
          type: patch.itemType,
          status: "in_progress",
          text: patch.delta,
          at: patch.at
        });
      }
      if (patch.kind === "runtime-message" && patch.turnId) {
        traceBuffer.upsertItem({
          turnId: patch.turnId,
          itemId: `${patch.turnId}:runtime:${patch.at}`,
          type: "error",
          status: patch.tone === "error" ? "failed" : "completed",
          text: patch.message,
          title: patch.tone === "error" ? "Runtime error" : "Runtime warning",
          at: patch.at,
          completedAt: patch.at
        });
      }
      if (patch.kind === "item-lifecycle" && patch.itemType === "user_message" && patch.text.trim()) {
        removeCommittedPendingOperatorPrompt(access, patch.text, patch.at);
      }
      if (
        patch.kind === "item-lifecycle" &&
        patch.status === "completed" &&
        (patch.itemType === "user_message" || patch.itemType === "assistant_message") &&
        isPersistableProviderOperatorMessage(patch.itemType === "user_message" ? "user" : "assistant", patch.text)
      ) {
        const traceMeta = patch.itemType === "assistant_message"
          ? traceBuffer.consumeForAssistantItem(patch.itemId)
          : null;
        operatorMessageChanged =
          upsertProviderBackedOperatorMessage(
            access.operatorMessages,
            `operator-session-${patch.itemId}`,
            patch.text,
            patch.at,
            patch.itemType === "user_message" ? "user" : "assistant",
            null,
            traceMeta
              ? { trace: traceMeta.items, traceMeta }
              : {}
          ) || operatorMessageChanged;
      }
      access.emit("butlerPatch", patch);
    }

    if (operatorMessageChanged) {
      void access.saveOperatorMessageState();
    }

    if (event.type === "compaction_start") {
      access.compaction.lastReason = event.reason;
      access.compaction.lastStartedAt = Date.now();
      access.compaction.lastError = null;
      access.compaction.lastAborted = false;
    }

    if (event.type === "compaction_end") {
      access.compaction.lastReason = event.reason;
      access.compaction.lastCompletedAt = Date.now();
      access.compaction.lastWillRetry = event.willRetry;
      access.compaction.lastAborted = event.aborted;
      access.compaction.lastError = event.errorMessage ?? null;
      access.compaction.lastTokensBefore = event.result?.tokensBefore ?? access.compaction.lastTokensBefore;
    }

    access.ready = true;
    access.emit("change");
  });
}

function liveChatGptModelIds(access: ButlerAgentSessionAccess): Set<string> | null {
  if (access.auth.mode !== "chatgpt") return null;
  const state = access.codexClient.getConnectionState();
  const models = state.compose.availableModels;
  if (!state.connected || models.length === 0) return null;
  return new Set(models.map((model) => parseProviderModelRef(model.id).model ?? model.id));
}

function isButlerModelProviderAuthenticated(access: ButlerAgentSessionAccess, provider: string | null | undefined): boolean {
  const settings = getActiveManorSettings();
  if (isOpenAiRuntimeProvider(provider)) {
    return access.auth.loggedIn || isSecretSourceAvailable({ type: "env", name: "OPENAI_API_KEY" });
  }
  if (provider === settings.providers.ollamaLocal.providerId || provider === "ollama-local") {
    return settings.providers.ollamaLocal.enabled;
  }
  if (provider === settings.providers.ollamaCloud.providerId || provider === "ollama-cloud") {
    return settings.providers.ollamaCloud.enabled && isSecretSourceAvailable(settings.providers.ollamaCloud.apiKeySource);
  }
  if (provider === settings.providers.opencodeGo.providerId || provider === "opencode-go") {
    return settings.providers.opencodeGo.enabled && isSecretSourceAvailable(settings.providers.opencodeGo.apiKeySource);
  }
  return false;
}

function getAvailableButlerModels(access: ButlerAgentSessionAccess): Model<Api>[] {
  const liveModelIds = liveChatGptModelIds(access);
  return (access.modelRegistry?.getAvailable() ?? []).filter((model) => {
    if (!shouldExposeManorModel(model)) return false;
    if (!isButlerModelProviderAuthenticated(access, model.provider)) return false;
    if (access.auth.mode === "chatgpt" && !isChatGptSubscriptionModelAvailable(model)) return false;
    if (!liveModelIds || !isOpenAiRuntimeProvider(model.provider)) return true;
    return liveModelIds.has(model.id);
  });
}

export async function applyManagedButlerDefaults(access: ButlerAgentSessionAccess): Promise<void> {
  if (!access.session || !access.modelRegistry) return;
  const fallbackSettings = getActiveManorSettings().butler;
  const lastUsed = typeof access.getButlerDefaults === "function" ? access.getButlerDefaults() : null;
  const defaultModel = lastUsed?.model ?? fallbackSettings.defaultModel;
  const defaultThinkingLevel = lastUsed?.thinkingLevel ?? fallbackSettings.defaultThinkingLevel;
  const ref = parseProviderModelRef(defaultModel);
  const availableModels = getAvailableButlerModels(access);
  let selectedModel: Model<Api> | null = null;
  let modelChanged = false;
  if (ref.model) {
    const providers = ref.provider
      ? [ref.provider]
      : access.auth.mode === "chatgpt"
        ? ["openai-codex", "openai"]
        : ["openai", "openai-codex"];
    selectedModel = providers
      .map((provider) => availableModels.find((model) => model.provider === provider && model.id === ref.model))
      .find(Boolean) ?? null;
  }
  const currentModel = access.session.model
    ? availableModels.find((model) => model.provider === access.session?.model?.provider && model.id === access.session?.model?.id) ?? null
    : null;
  selectedModel ??= currentModel ?? availableModels[0] ?? null;
  if (selectedModel && selectedModel !== access.session.model) {
    await access.session.setModel(selectedModel);
    modelChanged = true;
  }
  const activeModel = modelChanged
    ? selectedModel
    : access.session.model
      ? availableModels.find((model) => model.provider === access.session?.model?.provider && model.id === access.session?.model?.id) ?? null
      : null;
  const option = activeModel ? modelToModelOption(activeModel) : null;
  const levels = option?.supportedThinkingLevels ?? [];
  const requestedThinkingLevel = defaultThinkingLevel as ButlerThinkingLevel;
  const thinkingLevel: ButlerThinkingLevel = levels.includes(requestedThinkingLevel)
    ? requestedThinkingLevel
    : fallbackThinkingLevel(levels, option?.defaultReasoningEffort as ButlerThinkingLevel | null | undefined);
  access.session.setThinkingLevel(piThinkingLevelForModelOption(thinkingLevel, option) as never);
}

export async function sanitizePersistedButlerSessions(access: ButlerAgentSessionAccess): Promise<void> {
  const entries = await fs.readdir(access.sessionDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const filePath = path.join(access.sessionDir, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n");
    let changed = false;
    const nextLines = lines.map((line) => {
      if (!line.trim()) {
        return line;
      }

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "message" || !parsed.message || typeof parsed.message !== "object") {
          return line;
        }

        const sanitized = sanitizeHistoryMessage(parsed.message);
        if (!sanitized.changed) {
          return line;
        }

        changed = true;
        return JSON.stringify({
          ...parsed,
          message: sanitized.message
        });
      } catch {
        return line;
      }
    });

    if (changed) {
      await fs.writeFile(filePath, nextLines.join("\n"), "utf8");
    }
  }
}

export function restoreButlerCompactionState(access: ButlerAgentSessionAccess): void {
  if (!access.session) {
    return;
  }

  const compactions = access.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
  const latestCompaction = compactions.at(-1);

  if (!latestCompaction) {
    return;
  }

  access.compaction.lastCompletedAt = Date.parse(latestCompaction.timestamp);
  access.compaction.lastTokensBefore = latestCompaction.tokensBefore ?? null;
}

export function getButlerContextUsage(access: ButlerAgentSessionAccess): ButlerContextUsageView {
  const contextUsage = access.session?.getSessionStats().contextUsage;

  return {
    tokens: contextUsage?.tokens ?? null,
    contextWindow: contextUsage?.contextWindow ?? null,
    percent: contextUsage?.percent ?? null
  };
}

export function getButlerCompactionSnapshot(access: ButlerAgentSessionAccess): ButlerCompactionView {
  if (!access.session) {
    return {
      autoEnabled: true,
      active: false,
      count: 0,
      ...access.compaction
    };
  }

  const count = access.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;

  return {
    autoEnabled: access.session.autoCompactionEnabled,
    active: access.session.isCompacting,
    count,
    ...access.compaction
  };
}

export async function runButlerPrompt(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[] = []
): Promise<void> {
  if (!access.session) {
    throw new Error("Butler agent is not ready");
  }

  let promptError: unknown = null;

  try {
    dropTrailingFailedButlerTurns(access);
    sanitizeButlerSessionMessages(access);
    const imageCapability = access.session.model ? modelToModelOption(access.session.model).inputCapabilities.image : "unknown";
    const visionSettings = getActiveManorSettings().vision;
    const needsVisionTool = imageReferenceIds.length > 0 && imageCapability !== "supported";
    if (needsVisionTool && !visionSettings.enabled && visionSettings.unavailableBehavior === "block") {
      throw new Error("The selected Butler model cannot see attached images and Vision assistance is disabled in Settings → Runtime.");
    }
    const promptText = needsVisionTool
      ? [
          text,
          visionSettings.enabled
            ? "The current model cannot receive image bytes. Use inspect_images with the reference ids above before making image-dependent claims."
            : "The current model cannot receive image bytes and Vision assistance is disabled. Do not claim to have inspected these images."
        ].join("\n\n")
      : text;
    await access.session.prompt(promptText, {
      ...(access.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      images: needsVisionTool ? [] : await access.imageStore.loadPiImages(imageReferenceIds)
    });
  } catch (error) {
    promptError = error;
  } finally {
    if (promptError) {
      dropTrailingFailedButlerTurns(access);
    }
    sanitizeButlerSessionMessages(access);
  }

  if (promptError) {
    throw promptError;
  }

  const latestFailure = extractLatestAssistantFailure(access);
  if (latestFailure) {
    dropTrailingFailedButlerTurns(access);
    throw new Error(latestFailure);
  }
}

export function extractLatestAssistantFailure(access: ButlerAgentSessionAccess): string | null {
  if (!access.session) {
    return null;
  }

  for (let index = access.session.messages.length - 1; index >= 0; index -= 1) {
    const message = access.session.messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }

    if ((message as { role?: string }).role !== "assistant") {
      continue;
    }

    if (!isAssistantFailureMessage(message)) {
      return null;
    }

    return typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "Butler request failed.";
  }

  return null;
}

export function dropTrailingFailedButlerTurns(access: ButlerAgentSessionAccess): void {
  if (!access.session) {
    return;
  }

  const trimmedMessages = [...access.session.messages];
  let changed = false;

  while (trimmedMessages.length > 0) {
    const lastMessage = trimmedMessages.at(-1);
    if (!isAssistantFailureMessage(lastMessage)) {
      break;
    }

    trimmedMessages.pop();
    changed = true;

    while (trimmedMessages.length > 0) {
      const previousMessage = trimmedMessages.at(-1);
      if (
        previousMessage &&
        typeof previousMessage === "object" &&
        (previousMessage as { role?: string }).role === "assistant"
      ) {
        break;
      }

      trimmedMessages.pop();
    }
  }

  if (!changed) {
    return;
  }

  access.session.agent.state.messages = trimmedMessages;
}

export function sanitizeButlerSessionMessages(access: ButlerAgentSessionAccess): void {
  if (!access.session) {
    return;
  }

  const sanitized = sanitizeHistoryMessages(access.session.messages);
  if (!sanitized.changed) {
    return;
  }

  access.session.agent.state.messages = sanitized.messages;
}

function isUserMessage(message: ButlerMessageView): boolean {
  return message.role === "user" || message.role === "user-with-attachments";
}

function matchesProviderBackedMessage(sessionMessage: ButlerMessageView, message: ButlerMessageView): boolean {
  if (message.role === "assistant") {
    if (sessionMessage.role !== "assistant") {
      return false;
    }

    const messageAt = message.at ?? 0;
    const sessionAt = sessionMessage.at ?? 0;
    return sessionMessage.text === message.text || (sessionAt >= messageAt - 1000 && Math.abs(sessionAt - messageAt) <= 30_000);
  }

  if (!isUserMessage(sessionMessage)) {
    return false;
  }
  const messageAt = message.at ?? 0;
  const sessionAt = sessionMessage.at ?? 0;
  return sessionMessage.text === message.text || (sessionAt >= messageAt - 1000 && Math.abs(sessionAt - messageAt) <= 30_000);
}

function preserveDurableAssistantTrace(providerMessage: ButlerMessageView, durableMessage: ButlerMessageView): void {
  if (providerMessage.role !== "assistant" || durableMessage.role !== "assistant") {
    return;
  }
  if (providerMessage.trace === undefined && durableMessage.trace !== undefined) {
    providerMessage.trace = durableMessage.trace.map((item) => ({ ...item }));
  }
  if (providerMessage.traceMeta === undefined && durableMessage.traceMeta !== undefined) {
    providerMessage.traceMeta = {
      ...durableMessage.traceMeta,
      items: durableMessage.traceMeta.items.map((item) => ({ ...item }))
    };
  }
}

function preserveDurableUserPresentation(providerMessage: ButlerMessageView, durableMessage: ButlerMessageView): void {
  if (!isUserMessage(providerMessage) || !isUserMessage(durableMessage)) return;
  if (durableMessage.displayText?.trim()) providerMessage.displayText = durableMessage.displayText;
  if (durableMessage.attachments?.length) providerMessage.attachments = durableMessage.attachments.map((attachment) => ({ ...attachment }));
}

function filterProviderBackedServerOperatorMessages(sessionMessages: ButlerMessageView[], messages: ButlerMessageView[]): ButlerMessageView[] {
  const consumedSessionMessageIds = new Set<string>();
  const exactMatchSessionMessageIds = new Set(sessionMessages.filter((sessionMessage) =>
    messages.some((message) => sessionMessage.text === message.text && matchesProviderBackedMessage(sessionMessage, message))
  ).map((message) => message.id));
  const fallbackOwnerBySessionMessageId = new Map<string, string>();
  for (const sessionMessage of sessionMessages) {
    if (exactMatchSessionMessageIds.has(sessionMessage.id)) continue;
    const owner = messages
      .filter((message) => message.pending !== true && matchesProviderBackedMessage(sessionMessage, message))
      .sort((left, right) => Math.abs((sessionMessage.at ?? 0) - (left.at ?? 0)) - Math.abs((sessionMessage.at ?? 0) - (right.at ?? 0)))[0];
    if (owner) fallbackOwnerBySessionMessageId.set(sessionMessage.id, owner.id);
  }
  return messages.filter((message) => {
    if (message.pending === true) {
      return true;
    }
    if (!isUserMessage(message) && !(message.role === "assistant" && message.id.startsWith("operator-session-"))) {
      return true;
    }
    const exactProviderMessage = sessionMessages.find((sessionMessage) =>
      !consumedSessionMessageIds.has(sessionMessage.id) &&
      sessionMessage.text === message.text &&
      matchesProviderBackedMessage(sessionMessage, message)
    );
    const providerMessage = exactProviderMessage ?? sessionMessages.find((sessionMessage) =>
      !consumedSessionMessageIds.has(sessionMessage.id) &&
      !exactMatchSessionMessageIds.has(sessionMessage.id) &&
      fallbackOwnerBySessionMessageId.get(sessionMessage.id) === message.id &&
      matchesProviderBackedMessage(sessionMessage, message)
    );
    if (!providerMessage) {
      return true;
    }
    preserveDurableUserPresentation(providerMessage, message);
    preserveDurableAssistantTrace(providerMessage, message);
    consumedSessionMessageIds.add(providerMessage.id);
    return false;
  });
}

function filterSessionMessagesShadowedByPendingPrompts(sessionMessages: ButlerMessageView[], pendingMessages: ButlerMessageView[]): ButlerMessageView[] {
  const pendingPrompts = pendingMessages.filter((message) => message.pending === true && isUserMessage(message));
  if (pendingPrompts.length === 0) {
    return sessionMessages;
  }

  const consumedPendingIds = new Set<string>();
  return sessionMessages.filter((sessionMessage) => {
    const pending = pendingPrompts.find((message) =>
      !consumedPendingIds.has(message.id) &&
      matchesProviderBackedMessage(sessionMessage, message)
    );
    if (!pending) {
      return true;
    }
    consumedPendingIds.add(pending.id);
    return false;
  });
}

function collapseDuplicateVisibleUserMessages(messages: ButlerMessageView[]): ButlerMessageView[] {
  const collapsed: ButlerMessageView[] = [];
  for (const message of messages) {
    const previous = collapsed.at(-1);
    const duplicateUserMessage =
      previous &&
      isUserMessage(previous) &&
      isUserMessage(message) &&
      (previous.displayText?.trim() || previous.text.trim()) === (message.displayText?.trim() || message.text.trim()) &&
      Math.abs((previous.at ?? 0) - (message.at ?? 0)) <= 30_000;
    if (duplicateUserMessage) {
      continue;
    }
    collapsed.push(message);
  }
  return collapsed;
}

export function removeCommittedPendingOperatorPrompt(access: ButlerAgentSessionAccess, text: string, at: number): void {
  const exactIndex = access.pendingOperatorMessages.findIndex((pending) =>
    pending.pending === true &&
    isUserMessage(pending) &&
    pending.text === text &&
    at >= (pending.at ?? 0) - 1000
  );
  const index = exactIndex >= 0 ? exactIndex : access.pendingOperatorMessages.findIndex((pending) =>
    pending.pending === true &&
    isUserMessage(pending) &&
    at >= (pending.at ?? 0) - 1000
  );
  if (index >= 0) {
    access.pendingOperatorMessages.splice(index, 1);
    access.pendingOperatorMessageRevision += 1;
  }
}

export function commitPendingOperatorPrompt(access: ButlerAgentSessionAccess, id: string | null | undefined): void {
  if (!id) {
    return;
  }
  const pending = access.pendingOperatorMessages.find((message) => message.id === id && message.pending === true);
  if (!pending) {
    return;
  }
  delete pending.pending;
  access.pendingOperatorMessageRevision += 1;
  access.emit("change");
}

export function registerPendingOperatorPrompt(access: ButlerAgentSessionAccess, text: string, displayText = text, attachments: ButlerMessageView["attachments"] = []): string {
  const at = Date.now();
  const id = `pending-operator-${at}-${access.pendingOperatorMessageSequence++}`;
  access.pendingOperatorMessages.push({
    id,
    role: "user",
    text,
    ...(displayText !== text ? { displayText } : {}),
    at,
    taskDurationMs: null,
    kind: "message",
    ...(attachments.length > 0 ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
    pending: true
  });
  if (access.pendingOperatorMessages.length > MAX_PENDING_OPERATOR_MESSAGES) {
    access.pendingOperatorMessages.splice(0, access.pendingOperatorMessages.length - MAX_PENDING_OPERATOR_MESSAGES);
  }
  access.pendingOperatorMessageRevision += 1;
  access.emit("change");
  return id;
}

export function removePendingOperatorPrompt(access: ButlerAgentSessionAccess, id: string | null | undefined): void {
  if (!id) {
    return;
  }
  const index = access.pendingOperatorMessages.findIndex((message) => message.id === id);
  if (index >= 0) {
    access.pendingOperatorMessages.splice(index, 1);
    access.pendingOperatorMessageRevision += 1;
    access.emit("change");
  }
}

export function clearPendingOperatorPrompts(access: ButlerAgentSessionAccess, options: { includeCommitted?: boolean } = {}): void {
  const before = access.pendingOperatorMessages.length;
  if (options.includeCommitted === true) {
    access.pendingOperatorMessages.splice(0, access.pendingOperatorMessages.length);
  } else {
    for (let index = access.pendingOperatorMessages.length - 1; index >= 0; index -= 1) {
      if (access.pendingOperatorMessages[index]?.pending === true) {
        access.pendingOperatorMessages.splice(index, 1);
      }
    }
  }
  if (access.pendingOperatorMessages.length !== before) {
    access.pendingOperatorMessageRevision += 1;
  }
}

export function keepPendingOperatorPromptsBefore(access: ButlerAgentSessionAccess, timestamp: number | null): void {
  if (timestamp === null) {
    clearPendingOperatorPrompts(access, { includeCommitted: true });
    return;
  }

  const before = access.pendingOperatorMessages.length;
  const deleteAfter = timestamp - 1;
  access.pendingOperatorMessages.splice(0, access.pendingOperatorMessages.length, ...access.pendingOperatorMessages.filter((entry) => (entry.at ?? 0) < deleteAfter));
  if (access.pendingOperatorMessages.length !== before) {
    access.pendingOperatorMessageRevision += 1;
  }
}

export function getVisibleButlerMessages(access: ButlerAgentSessionAccess) {
  const rawSessionMessages = access.session ? serializeMessages(access.session) : [];
  const sessionMessages = filterSessionMessagesShadowedByPendingPrompts(rawSessionMessages, access.pendingOperatorMessages);
  const pendingIds = new Set(access.pendingOperatorMessages.map((message) => message.id));
  const durableOperatorMessages = access.operatorMessages.filter((message) => !pendingIds.has(message.id));
  const serverOperatorMessages = filterProviderBackedServerOperatorMessages(sessionMessages, [...durableOperatorMessages, ...access.pendingOperatorMessages]);
  const visibleMessages = collapseDuplicateVisibleUserMessages(
    collapseCallbackDuplicateMessages(mergeVisibleMessages(sessionMessages, serverOperatorMessages as never[]))
  );
  removeTrivialOperatorQuestionConfirmations(visibleMessages, { providerBackedOnly: false });
  return visibleMessages;
}

export function getButlerMessagePage(
  access: ButlerAgentSessionAccess,
  before: number | null,
  limit: number
): ButlerMessagePageView {
  return buildMessagePage(getVisibleButlerMessages(access), before, limit);
}

export function getButlerLiveSnapshot(access: ButlerAgentSessionAccess): ButlerLiveSnapshot {
  const visibleMessages = getVisibleButlerMessages(access);
  const messageCount = visibleMessages.length;

  return {
    messages: visibleMessages.slice(Math.max(0, messageCount - SNAPSHOT_MESSAGE_TAIL_LIMIT)),
    messageCount,
    pendingRevision: access.pendingOperatorMessageRevision,
    activityTurns: getButlerActivityTurns(access, {
      maxCompletedTurns: 4,
      maxItemsPerTurn: 10,
      maxItemText: 700
    })
  };
}

export function getButlerShellSnapshot(access: ButlerAgentSessionAccess): AppShellSnapshot["butler"] {
  const availableModels = getAvailableButlerModels(access).map(modelToModelOption).map((model) => ({
    ...model,
    id: formatProviderModelRef({ provider: model.provider ?? null, model: model.id }) ?? model.id
  }));
  const currentModel = access.session?.model
    ? formatProviderModelRef({ provider: access.session.model.provider, model: access.session.model.id })
    : null;
  const selectedModel = availableModels.find((model) => model.id === currentModel) ?? availableModels[0] ?? null;
  const availableThinkingLevels = selectedModel?.supportedThinkingLevels?.length
    ? selectedModel.supportedThinkingLevels as ButlerThinkingLevel[]
    : [];
  const displayedSessionLevel = displayThinkingLevelForModelOption(access.session?.thinkingLevel as ButlerThinkingLevel | null | undefined, selectedModel);
  const currentThinkingLevel = displayedSessionLevel && availableThinkingLevels.includes(displayedSessionLevel)
    ? displayedSessionLevel
    : fallbackThinkingLevel(availableThinkingLevels, selectedModel?.defaultReasoningEffort as ButlerThinkingLevel | null | undefined);

  return {
    ready: access.ready,
    pending: access.pending || access.pendingOperatorMessages.some((message) => message.pending === true),
    isStreaming: access.session?.isStreaming ?? false,
    sessionId: access.session?.sessionId ?? null,
    model: currentModel,
    auth: access.auth as AppSnapshot["butler"]["auth"],
    tools: access.toolCatalog as AppSnapshot["butler"]["tools"],
    onboarding: access.onboarding as AppSnapshot["butler"]["onboarding"],
    contextUsage: getButlerContextUsage(access),
    compaction: getButlerCompactionSnapshot(access),
    supervision: {
      projects: access.store.listProjectSummaries(),
      supervisor: access.store.getSupervisorSummary(),
      callbacks: [...access.pendingChatCallbacks.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    },
    pendingManorRestartRequest: access.pendingManorRestartRequest,
    authorizedManorRestartRequest: access.authorizedManorRestartRequest,
    scratchPad: {
      items: [],
      counts: { captured: 0, exploring: 0, ready_for_review: 0, accepted: 0, parked: 0, dismissed: 0 },
      readinessCounts: {
        captured: 0,
        exploring: 0,
        reviewing: 0,
        needs_rework: 0,
        ready: 0,
        accepted: 0,
        parked: 0,
        dismissed: 0,
        blocked: 0
      }
    },
    lastError: access.lastError,
    compose: {
      provider: access.session?.model?.provider ?? null,
      model: currentModel,
      thinkingLevel: currentThinkingLevel,
      availableThinkingLevels,
      availableModels
    }
  };
}

export function getButlerSnapshot(access: ButlerAgentSessionAccess): AppSnapshot["butler"] {
  const liveSnapshot = getButlerLiveSnapshot(access);
  const shellSnapshot = getButlerShellSnapshot(access);

  return {
    ...shellSnapshot,
    ...liveSnapshot,
    latestPreviewProofsByThreadId: buildLatestProofMap(access.store.listPreviewProofs()),
    previewProofsByThreadId: buildProofsByThreadMap(access.store.listPreviewProofs()),
    stacks: access.store.listStackLeases(),
    previews: access.store.listPreviewLeases(),
    serviceTemplates: access.listServiceTemplates(),
    services: access.store.listServiceLeases(),
    desktopSessions: access.store.listDesktopSessions()
  };
}

export async function promptButler(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[] = [],
  options: { mode?: "queue" | "steer"; pendingOperatorMessageId?: string | null; displayText?: string | null; ignoreStopRequestSequence?: number | null; fileReferenceIds?: string[] } = {}
): Promise<boolean> {
  if (options.mode === "steer" && !options.pendingOperatorMessageId) {
    clearPendingOperatorPrompts(access);
  }
  const pendingOperatorMessageId = options.pendingOperatorMessageId ?? registerPendingOperatorPrompt(access, text, options.displayText?.trim() || text);
  let ignoreStopRequestSequence = options.ignoreStopRequestSequence ?? null;
  if (options.mode === "steer") {
    await stopButlerPrompt(access, { clearPendingOperatorMessages: false });
    ignoreStopRequestSequence = access.stopRequestSequence;
  }

  return queueButlerPrompt(access, text, imageReferenceIds, { background: false, pendingOperatorMessageId, ignoreStopRequestSequence, fileReferenceIds: options.fileReferenceIds });
}

export async function stopButlerPrompt(access: ButlerAgentSessionAccess, options: { clearPendingOperatorMessages?: boolean } = {}): Promise<boolean> {
  const active = Boolean(access.pending || access.session?.isStreaming || access.session?.isCompacting);
  access.stopRequestedAt = Date.now();
  access.stopRequestSequence += 1;
  access.pending = false;
  access.lastError = null;
  if (options.clearPendingOperatorMessages !== false) {
    clearPendingOperatorPrompts(access);
  }

  if (access.session && (access.session.isStreaming || access.session.isCompacting)) {
    await access.session.abort();
  }

  finalizeButlerActivityTurn(access, "interrupted", "Butler was stopped by the operator.");

  access.emit("change");
  return active;
}

export async function promptButlerInternal(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[] = [],
  options: { ephemeral?: boolean } = {}
): Promise<void> {
  const withoutBackgroundMarker = text
    .replace(/^\s*\[\[BUTLER_(?:EPHEMERAL_)?BACKGROUND\]\]\s*/u, "")
    .trimStart();
  const normalizedText = `${options.ephemeral ? BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX : BUTLER_BACKGROUND_PROMPT_PREFIX}\n${withoutBackgroundMarker}`;
  const ok = await queueButlerPrompt(access, normalizedText, imageReferenceIds, { background: true });
  if (!ok) {
    throw new Error(access.lastError ?? "Butler background supervision prompt failed.");
  }
}

export function activateOperatorReferences(
  access: Pick<ButlerAgentSessionAccess, "activeOperatorReferences">,
  references: ButlerAgentSessionAccess["activeOperatorReferences"]
): () => void {
  access.activeOperatorReferences = references;
  return () => {
    if (access.activeOperatorReferences === references) access.activeOperatorReferences = null;
  };
}

export async function syncOperatorMessagesFromSessionFiles(
  access: Pick<ButlerAgentSessionAccess, "operatorMessages" | "sessionDir" | "saveOperatorMessageState">
): Promise<boolean> {
  const changed = await backfillOperatorMessagesFromSessionFiles(access.operatorMessages, access.sessionDir);
  if (changed) {
    await access.saveOperatorMessageState();
  }
  return changed;
}

async function queueButlerPrompt(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[],
  options: { background: boolean; pendingOperatorMessageId?: string | null; ignoreStopRequestSequence?: number | null; fileReferenceIds?: string[] }
): Promise<boolean> {
  if (!access.session) {
    if (!options.background) {
      removePendingOperatorPrompt(access, options.pendingOperatorMessageId);
    }
    throw new Error("Butler agent is not ready");
  }

  const acceptedStopRequestSequence = options.ignoreStopRequestSequence ?? access.stopRequestSequence;
  const operatorReferences = options.background ? null : {
    imageReferenceIds: [...new Set(imageReferenceIds)],
    fileReferenceIds: [...new Set(options.fileReferenceIds ?? [])]
  };

  if (!options.background) {
    access.pending = true;
    access.lastError = null;
    access.emit("change");
  }

  const execute = async () => {
    const clearOperatorReferences = activateOperatorReferences(access, operatorReferences);
    const promptStartedAt = Date.now();
    let ok = true;
    try {
      const nextAuth = await readButlerAuthStatus(access.piAuthPath);
      if (nextAuth.mode !== access.auth.mode || nextAuth.loggedIn !== access.auth.loggedIn) {
        access.auth = nextAuth;
        access.modelRegistry = await createManorModelRegistry(access.piAuthPath, process.env, {
          preferredModelRef: access.getButlerDefaults?.()?.model
        });
        await createOrRefreshButlerSession(access);
      } else {
        access.auth = nextAuth;
      }
      await access.reconcilePendingChatCallbacks();
      if (!options.background && hasBlockingStopRequest(access, acceptedStopRequestSequence)) {
        removePendingOperatorPrompt(access, options.pendingOperatorMessageId);
        return false;
      }
      await runButlerPrompt(access, text, imageReferenceIds);
      if (!options.background) {
        await syncOperatorMessagesFromSessionFiles(access);
      }
      if (!options.background) {
        commitPendingOperatorPrompt(access, options.pendingOperatorMessageId);
      }
      access.lastError = null;
    } catch (error) {
      const stopped = !options.background && hasBlockingStopRequest(access, acceptedStopRequestSequence);
      const detail = error instanceof Error ? error.message : String(error);
      if (stopped) {
        access.lastError = null;
        finalizeButlerActivityTurn(access, "interrupted", "Butler was stopped by the operator.");
      } else {
        access.lastError = detail;
        finalizeButlerActivityTurn(access, "failed", detail, Date.now(), promptStartedAt);
      }
      if (!options.background) {
        removePendingOperatorPrompt(access, options.pendingOperatorMessageId);
      }
      ok = false;
    } finally {
      clearOperatorReferences();
      await access.refreshExternalStatus();
      if (!options.background) {
        access.pending = false;
      }
      access.emit("change");
    }

    return ok;
  };

  const queued = access.promptQueue.then(execute, execute);
  access.promptQueue = queued.then(() => undefined);
  return queued;
}

export function hasBlockingStopRequest(access: ButlerAgentSessionAccess, acceptedStopRequestSequence: number): boolean {
  return access.stopRequestSequence > acceptedStopRequestSequence;
}

export async function updateButlerComposeSettings(
  access: ButlerAgentSessionAccess,
  provider: string,
  modelId: string,
  thinkingLevel: ButlerThinkingLevel
): Promise<void> {
  if (!access.session || !access.modelRegistry) {
    throw new Error("Butler agent is not ready");
  }

  const parsedRef = parseProviderModelRef(modelId);
  const ref = provider && parsedRef.provider !== provider
    ? { provider, model: modelId }
    : { provider: provider || parsedRef.provider, model: parsedRef.model ?? modelId };
  const lookupModelId = ref.model ?? modelId;
  const lookupProvider = provider || ref.provider;
  const lookupProviders = lookupProvider
    ? [lookupProvider]
    : access.auth.mode === "chatgpt"
      ? ["openai-codex", "openai"]
      : ["openai", "openai-codex"];
  const availableModels = getAvailableButlerModels(access);

  const model = lookupProviders
    .map((candidateProvider) => availableModels.find((entry) => entry.provider === candidateProvider && entry.id === lookupModelId))
    .find(Boolean);
  if (!model) {
    throw new Error("Selected Butler model is not available");
  }

  await access.session.setModel(model);
  const option = modelToModelOption(model);
  const levels = option.supportedThinkingLevels;
  const nextThinkingLevel = levels.includes(thinkingLevel)
    ? thinkingLevel
    : fallbackThinkingLevel(levels, option.defaultReasoningEffort as ButlerThinkingLevel | null | undefined);
  access.session.setThinkingLevel(piThinkingLevelForModelOption(nextThinkingLevel, option) as never);
  syncVisionToolForSession(access.session);
  await syncProviderWebToolsForSession(access.session);
  access.lastError = null;
  access.emit("change");
}
