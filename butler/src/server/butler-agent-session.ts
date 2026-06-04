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
import type {
  AppShellSnapshot,
  AppSnapshot,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerLiveSnapshot,
  ButlerMessagePageView,
  ButlerThinkingLevel
} from "./types.js";

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

  access.unsubscribeSession = access.session.subscribe((event) => {
    recordButlerActivityEvent(access, event);

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
    await access.session.prompt(text, {
      ...(access.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      images: await access.imageStore.loadPiImages(imageReferenceIds)
    });
  } catch (error) {
    promptError = error;
  } finally {
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

export function getVisibleButlerMessages(access: ButlerAgentSessionAccess) {
  const sessionMessages = access.session ? serializeMessages(access.session) : [];
  return collapseCallbackDuplicateMessages(mergeVisibleMessages(sessionMessages, access.operatorMessages as never[]));
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
    activityTurns: getButlerActivityTurns(access)
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
    pending: access.pending,
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
    scratchPad: {
      items: [],
      counts: { captured: 0, exploring: 0, ready_for_review: 0, accepted: 0, parked: 0, dismissed: 0 }
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
  options: { mode?: "queue" | "steer" } = {}
): Promise<boolean> {
  if (options.mode === "steer") {
    await stopButlerPrompt(access);
  }

  return queueButlerPrompt(access, text, imageReferenceIds, { background: false });
}

export async function stopButlerPrompt(access: ButlerAgentSessionAccess): Promise<boolean> {
  const active = Boolean(access.pending || access.session?.isStreaming || access.session?.isCompacting);
  access.stopRequestedAt = Date.now();
  access.pending = false;
  access.lastError = null;

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
  options: { background: boolean }
): Promise<boolean> {
  if (!access.session) {
    throw new Error("Butler agent is not ready");
  }

  const queuedAt = Date.now();

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
      if (!options.background && access.stopRequestedAt !== null && access.stopRequestedAt >= queuedAt) {
        return false;
      }
      await runButlerPrompt(access, text, imageReferenceIds);
      access.lastError = null;
    } catch (error) {
      if (!options.background && access.stopRequestedAt !== null && access.stopRequestedAt >= queuedAt) {
        access.lastError = null;
      } else {
        access.lastError = error instanceof Error ? error.message : String(error);
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
