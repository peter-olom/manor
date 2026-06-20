import { promises as fs } from "node:fs";
import path from "node:path";

import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

import {
  BUTLER_BACKGROUND_PROMPT_PREFIX,
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
import { getButlerActivityTurns, recordButlerActivityEvent } from "./butler-activity.js";
import { isPersistableProviderOperatorMessage, removeTrivialOperatorQuestionConfirmations, upsertProviderBackedOperatorMessage } from "./butler-operator-messages.js";
import { PiProviderRuntimeMapper } from "./pi-provider-events.js";
import type {
  AppShellSnapshot,
  AppSnapshot,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerLiveSnapshot,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerThinkingLevel
} from "./types.js";

const MAX_PENDING_OPERATOR_MESSAGES = 20;

export async function createOrRefreshButlerSession(access: ButlerAgentSessionAccess): Promise<void> {
  if (!access.modelRegistry) {
    throw new Error("Butler model registry is not ready");
  }

  access.unsubscribeSession?.();
  access.unsubscribeSession = null;

  await sanitizePersistedButlerSessions(access);

  const authStorage = AuthStorage.create(access.piAuthPath);
  const resourceLoader = new DefaultResourceLoader({
    cwd: "/repos",
    agentDir: path.dirname(access.piAuthPath),
    systemPromptOverride: () => buildSystemPrompt(access.store, access.describePendingCallbacks())
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

  const runtimeMapper = new PiProviderRuntimeMapper();
  access.unsubscribeSession = access.session.subscribe((event) => {
    recordButlerActivityEvent(access, event);
    const patches = runtimeMapper.map(event, access.session!);
    let operatorMessageChanged = false;
    for (const patch of patches) {
      if (patch.kind === "item-lifecycle" && patch.itemType === "user_message" && patch.text.trim()) {
        removeCommittedPendingOperatorPrompt(access, patch.text, patch.at);
      }
      if (
        patch.kind === "item-lifecycle" &&
        patch.status === "completed" &&
        (patch.itemType === "user_message" || patch.itemType === "assistant_message") &&
        isPersistableProviderOperatorMessage(patch.itemType === "user_message" ? "user" : "assistant", patch.text)
      ) {
        operatorMessageChanged =
          upsertProviderBackedOperatorMessage(
            access.operatorMessages,
            `operator-session-${patch.itemId}`,
            patch.text,
            patch.at,
            patch.itemType === "user_message" ? "user" : "assistant"
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
    await access.session.prompt(text, {
      ...(access.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      images: await access.imageStore.loadPiImages(imageReferenceIds)
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

function filterProviderBackedServerOperatorMessages(sessionMessages: ButlerMessageView[], messages: ButlerMessageView[]): ButlerMessageView[] {
  const consumedSessionMessageIds = new Set<string>();
  return messages.filter((message) => {
    if (message.pending === true) {
      return true;
    }
    if (!isUserMessage(message) && !(message.role === "assistant" && message.id.startsWith("operator-session-"))) {
      return true;
    }
    const providerMessage = sessionMessages.find((sessionMessage) =>
      !consumedSessionMessageIds.has(sessionMessage.id) &&
      matchesProviderBackedMessage(sessionMessage, message)
    );
    if (!providerMessage) {
      return true;
    }
    consumedSessionMessageIds.add(providerMessage.id);
    return false;
  });
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

export function registerPendingOperatorPrompt(access: ButlerAgentSessionAccess, text: string, displayText = text): string {
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
  const sessionMessages = access.session ? serializeMessages(access.session) : [];
  const pendingIds = new Set(access.pendingOperatorMessages.map((message) => message.id));
  const durableOperatorMessages = access.operatorMessages.filter((message) => !pendingIds.has(message.id));
  const serverOperatorMessages = filterProviderBackedServerOperatorMessages(sessionMessages, [...durableOperatorMessages, ...access.pendingOperatorMessages]);
  const visibleMessages = collapseCallbackDuplicateMessages(mergeVisibleMessages(sessionMessages, serverOperatorMessages as never[]));
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
  const codexCompose = access.codexClient.getConnectionState().compose;
  const availableModels = codexCompose.availableModels;
  const availableThinkingLevels = ["low", "medium", "high", "xhigh"] as ButlerThinkingLevel[];
  const currentThinkingLevel = availableThinkingLevels.includes(access.session?.thinkingLevel as ButlerThinkingLevel)
    ? (access.session?.thinkingLevel as ButlerThinkingLevel)
    : "medium";

  return {
    ready: access.ready,
    pending: access.pending || access.pendingOperatorMessages.some((message) => message.pending === true),
    isStreaming: access.session?.isStreaming ?? false,
    sessionId: access.session?.sessionId ?? null,
    model: access.session?.model?.id ?? null,
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
      model: access.session?.model?.id ?? null,
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
  options: { mode?: "queue" | "steer"; pendingOperatorMessageId?: string | null; displayText?: string | null; ignoreStopRequestSequence?: number | null } = {}
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

  return queueButlerPrompt(access, text, imageReferenceIds, { background: false, pendingOperatorMessageId, ignoreStopRequestSequence });
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

  access.emit("change");
  return active;
}

export async function promptButlerInternal(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[] = []
): Promise<void> {
  const normalizedText = text.trimStart().startsWith(BUTLER_BACKGROUND_PROMPT_PREFIX)
    ? text
    : `${BUTLER_BACKGROUND_PROMPT_PREFIX}\n${text}`;
  const ok = await queueButlerPrompt(access, normalizedText, imageReferenceIds, { background: true });
  if (!ok) {
    throw new Error(access.lastError ?? "Butler background supervision prompt failed.");
  }
}

async function queueButlerPrompt(
  access: ButlerAgentSessionAccess,
  text: string,
  imageReferenceIds: string[],
  options: { background: boolean; pendingOperatorMessageId?: string | null; ignoreStopRequestSequence?: number | null }
): Promise<boolean> {
  if (!access.session) {
    if (!options.background) {
      removePendingOperatorPrompt(access, options.pendingOperatorMessageId);
    }
    throw new Error("Butler agent is not ready");
  }

  const acceptedStopRequestSequence = options.ignoreStopRequestSequence ?? access.stopRequestSequence;

  if (!options.background) {
    access.pending = true;
    access.lastError = null;
    access.emit("change");
  }

  const execute = async () => {
    let ok = true;
    try {
      const nextAuth = await readButlerAuthStatus(access.piAuthPath);
      if (nextAuth.mode !== access.auth.mode || nextAuth.loggedIn !== access.auth.loggedIn) {
        access.auth = nextAuth;
        access.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(access.piAuthPath));
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
        commitPendingOperatorPrompt(access, options.pendingOperatorMessageId);
      }
      access.lastError = null;
    } catch (error) {
      if (!options.background && hasBlockingStopRequest(access, acceptedStopRequestSequence)) {
        access.lastError = null;
      } else {
        access.lastError = error instanceof Error ? error.message : String(error);
      }
      if (!options.background) {
        removePendingOperatorPrompt(access, options.pendingOperatorMessageId);
      }
      ok = false;
    } finally {
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

  const lookupProviders = provider
    ? [provider]
    : access.auth.mode === "chatgpt"
      ? ["openai-codex", "openai"]
      : ["openai", "openai-codex"];

  const model = lookupProviders
    .map((candidateProvider) => access.modelRegistry?.find(candidateProvider, modelId))
    .find(Boolean);
  if (!model) {
    throw new Error("Selected Butler model is not available");
  }

  await access.session.setModel(model);
  access.session.setThinkingLevel(thinkingLevel === "off" || thinkingLevel === "minimal" ? "medium" : thinkingLevel);
  access.lastError = null;
  access.emit("change");
}
