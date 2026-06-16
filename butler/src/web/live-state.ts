import { useEffect, useSyncExternalStore } from "react";

import { getJson } from "./api";
import type {
  ProviderRuntimeContentStreamKind,
  ProviderRuntimeItemStatus,
  ProviderRuntimeItemType,
  ProviderRuntimePatchTelemetry,
  ProviderRuntimeThreadState,
  ProviderRuntimeTurnState
} from "../shared/provider-runtime";
import type {
  BootstrapSnapshot,
  ButlerLivePatch,
  ButlerLiveSnapshot,
  CodexThreadDetail,
  CodexThreadPatch,
  ImageReference,
  ComposerPrefill,
  RuntimeSnapshot,
  ServerToastEvent,
  ShellSnapshot,
  ThreadStatus,
  TransportState
} from "./types";

type Listener = () => void;
type BootstrapChannel = "shell" | "butlerLive" | "runtime" | "threads";
type BootstrapChannelVersions = Record<BootstrapChannel, number>;
type HeartbeatPayload =
  | number
  | {
      at?: number;
      channelVersions?: Partial<BootstrapChannelVersions>;
    };

function createStore<T>(initialValue: T) {
  let value = initialValue;
  const listeners = new Set<Listener>();

  return {
    getSnapshot(): T {
      return value;
    },
    setSnapshot(nextValue: T): void {
      if (Object.is(value, nextValue)) {
        return;
      }
      value = nextValue;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

const shellStore = createStore<ShellSnapshot | null>(null);
const butlerLiveStore = createStore<ButlerLiveSnapshot | null>(null);
const runtimeStore = createStore<RuntimeSnapshot | null>(null);
const openThreadsStore = createStore<Record<string, CodexThreadDetail>>({});
const imagesStore = createStore<ImageReference[]>([]);
const serverToastStore = createStore<ServerToastEvent | null>(null);
const transportStore = createStore<TransportState>({
  connected: false,
  disconnected: false,
  reconnecting: false,
  lastEventAt: null,
  lastError: null
});

let started = false;
let eventSource: EventSource | null = null;
let bootstrapPromise: Promise<void> | null = null;
let bootstrapRefreshInFlight: Promise<void> | null = null;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let disconnectNoticeTimer: number | null = null;
let connectionAttempt = 0;
let reconnectAttempt = 0;
let lastBootstrapRefreshAt = 0;
let pageResyncHandlersInstalled = false;
const lastStateEventAtByChannel: Record<BootstrapChannel, number> = {
  shell: 0,
  butlerLive: 0,
  runtime: 0,
  threads: 0
};
const lastAppliedChannelVersion: BootstrapChannelVersions = {
  shell: 0,
  butlerLive: 0,
  runtime: 0,
  threads: 0
};
const lastServerChannelVersion: BootstrapChannelVersions = {
  shell: 0,
  butlerLive: 0,
  runtime: 0,
  threads: 0
};
const inflightThreadLoads = new Map<string, Promise<void>>();
const EVENT_STREAM_PATH = "/api/events";
const EVENT_SOURCE_CONNECT_TIMEOUT_MS = 10_000;
const BOOTSTRAP_REFRESH_TIMEOUT_MS = 12_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const DISCONNECT_NOTICE_DELAY_MS = 20_000;
const FOREGROUND_RESYNC_MIN_INTERVAL_MS = 3_000;
const VISIBLE_RESYNC_MIN_INTERVAL_MS = 30_000;
const VISIBLE_RESYNC_CHECK_INTERVAL_MS = 10_000;
const VERSION_GAP_RESYNC_MIN_INTERVAL_MS = 1_000;
const BOOTSTRAP_CHANNELS: readonly BootstrapChannel[] = ["shell", "butlerLive", "runtime", "threads"];
const LIVE_STREAM_TELEMETRY_ENDPOINT = "/api/telemetry/live-stream";
const LIVE_STREAM_TELEMETRY_FLUSH_MS = 750;
const LIVE_STREAM_TELEMETRY_MAX_BATCH = 100;
const LIVE_STREAM_TELEMETRY_MAX_QUEUE = 500;

type LiveStreamTelemetryAck = {
  id: string;
  eventName: "butlerPatch";
  browserReceivedAt: number;
  browserStateAppliedAt: number;
  browserRenderedAt: number;
};

const liveStreamTelemetryQueue: LiveStreamTelemetryAck[] = [];
let liveStreamTelemetryFlushTimer: number | null = null;
let liveStreamTelemetryInFlight = false;

function setTransportState(nextValue: Partial<TransportState>): void {
  const current = transportStore.getSnapshot();
  const merged = { ...current, ...nextValue };
  if (
    current.connected === merged.connected &&
    current.disconnected === merged.disconnected &&
    current.reconnecting === merged.reconnecting &&
    current.lastEventAt === merged.lastEventAt &&
    current.lastError === merged.lastError
  ) {
    return;
  }
  transportStore.setSnapshot(merged);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimer !== null) {
    window.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearDisconnectNoticeTimer(): void {
  if (disconnectNoticeTimer !== null) {
    window.clearTimeout(disconnectNoticeTimer);
    disconnectNoticeTimer = null;
  }
}

function closeEventSource(): void {
  if (!eventSource) {
    return;
  }

  eventSource.onopen = null;
  eventSource.onerror = null;
  eventSource.close();
  eventSource = null;
}

function markTransportAlive(): void {
  reconnectAttempt = 0;
  clearDisconnectNoticeTimer();
  const now = Date.now();
  setTransportState({
    connected: true,
    disconnected: false,
    reconnecting: false,
    lastEventAt: now,
    lastError: null
  });
  clearHeartbeatTimer();
  heartbeatTimer = window.setTimeout(() => {
    scheduleReconnect("Live updates stalled");
  }, HEARTBEAT_TIMEOUT_MS);
  requestVisiblePageResync(VISIBLE_RESYNC_MIN_INTERVAL_MS);
}

export function selectBootstrapChannelsToApply(
  lastEventAtByChannel: Record<BootstrapChannel, number>,
  requestedAt: number
): BootstrapChannel[] {
  return BOOTSTRAP_CHANNELS.filter((channel) => lastEventAtByChannel[channel] <= requestedAt);
}

export function selectOutdatedBootstrapChannels(
  appliedVersions: BootstrapChannelVersions,
  serverVersions: BootstrapChannelVersions
): BootstrapChannel[] {
  return BOOTSTRAP_CHANNELS.filter((channel) => serverVersions[channel] > appliedVersions[channel]);
}

export function shouldApplyChannelEvent(appliedVersion: number, eventVersion: number | null): boolean {
  return eventVersion === null || eventVersion >= appliedVersion;
}

export function shouldRefreshLiveStateOnPageEvent(input: {
  now: number;
  lastRefreshAt: number;
  minIntervalMs: number;
  hasSnapshot: boolean;
  visibilityState: DocumentVisibilityState | "unknown";
}): boolean {
  if (input.visibilityState === "hidden") {
    return false;
  }
  return !input.hasSnapshot || input.now - input.lastRefreshAt >= input.minIntervalMs;
}

function parseEventData<T>(event: Event): T {
  return JSON.parse((event as MessageEvent<string>).data) as T;
}

function scheduleLiveStreamTelemetryFlush(): void {
  if (liveStreamTelemetryFlushTimer !== null || liveStreamTelemetryInFlight || liveStreamTelemetryQueue.length === 0) {
    return;
  }
  liveStreamTelemetryFlushTimer = window.setTimeout(() => {
    liveStreamTelemetryFlushTimer = null;
    flushLiveStreamTelemetry();
  }, LIVE_STREAM_TELEMETRY_FLUSH_MS);
}

function flushLiveStreamTelemetry(): void {
  if (liveStreamTelemetryInFlight || liveStreamTelemetryQueue.length === 0) {
    return;
  }

  liveStreamTelemetryInFlight = true;
  const batch = liveStreamTelemetryQueue.splice(0, LIVE_STREAM_TELEMETRY_MAX_BATCH);
  void window.fetch(LIVE_STREAM_TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ acks: batch }),
    keepalive: true
  })
    .catch(() => {
      liveStreamTelemetryQueue.unshift(...batch);
      if (liveStreamTelemetryQueue.length > LIVE_STREAM_TELEMETRY_MAX_QUEUE) {
        liveStreamTelemetryQueue.splice(0, liveStreamTelemetryQueue.length - LIVE_STREAM_TELEMETRY_MAX_QUEUE);
      }
    })
    .finally(() => {
      liveStreamTelemetryInFlight = false;
      scheduleLiveStreamTelemetryFlush();
    });
}

function queueButlerPatchTelemetry(
  telemetry: ProviderRuntimePatchTelemetry | undefined,
  browserReceivedAt: number,
  browserStateAppliedAt: number
): void {
  if (!telemetry?.id) {
    return;
  }

  const enqueue = () => {
    liveStreamTelemetryQueue.push({
      id: telemetry.id,
      eventName: "butlerPatch",
      browserReceivedAt,
      browserStateAppliedAt,
      browserRenderedAt: Date.now()
    });
    if (liveStreamTelemetryQueue.length > LIVE_STREAM_TELEMETRY_MAX_QUEUE) {
      liveStreamTelemetryQueue.splice(0, liveStreamTelemetryQueue.length - LIVE_STREAM_TELEMETRY_MAX_QUEUE);
    }
    scheduleLiveStreamTelemetryFlush();
  };

  window.requestAnimationFrame(enqueue);
}

function parseEventChannelVersion(event: Event, channel: BootstrapChannel): number | null {
  const eventId = (event as MessageEvent<string>).lastEventId;
  const prefix = `${channel}:`;
  if (!eventId.startsWith(prefix)) {
    return null;
  }

  const version = Number(eventId.slice(prefix.length));
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function applyChannelVersion(channel: BootstrapChannel, version: number): void {
  lastAppliedChannelVersion[channel] = Math.max(lastAppliedChannelVersion[channel], version);
  lastServerChannelVersion[channel] = Math.max(lastServerChannelVersion[channel], version);
}

function updateServerChannelVersions(versions: Partial<BootstrapChannelVersions> | undefined): void {
  if (!versions) {
    return;
  }

  for (const channel of BOOTSTRAP_CHANNELS) {
    const version = versions[channel];
    if (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) {
      lastServerChannelVersion[channel] = Math.max(lastServerChannelVersion[channel], version);
    }
  }
}

function parseHeartbeatChannelVersions(event: Event): Partial<BootstrapChannelVersions> | undefined {
  const payload = parseEventData<HeartbeatPayload>(event);
  if (payload && typeof payload === "object") {
    return payload.channelVersions;
  }
  return undefined;
}

export function applyButlerLivePatchSnapshot(
  current: ButlerLiveSnapshot | null,
  patch: ButlerLivePatch
): ButlerLiveSnapshot | null {
  if (!current) {
    return current;
  }

  if (patch.kind === "content-delta" && patch.streamKind === "assistant_text") {
    return upsertButlerMessage(current, {
      id: patch.itemId,
      role: "assistant",
      text: readButlerMessageText(current, patch.itemId) + patch.delta,
      at: patch.at,
      taskDurationMs: null,
      kind: "message"
    });
  }

  if (patch.kind === "item-lifecycle" && (patch.itemType === "assistant_message" || patch.itemType === "user_message")) {
    if (!patch.text.trim()) {
      return current;
    }
    const base = patch.itemType === "user_message" ? removeCommittedPendingButlerMessage(current, patch.text, patch.at) : current;
    return upsertButlerMessage(base, {
      id: patch.itemId,
      role: patch.itemType === "user_message" ? "user" : "assistant",
      text: patch.text,
      at: patch.at,
      taskDurationMs: null,
      kind: "message"
    });
  }

  if (patch.kind === "turn-lifecycle") {
    return patchButlerActivityTurn(current, patch.turnId, patch.at, (turn) => ({
      ...turn,
      status: patch.status === "started" ? "active" : "completed",
      completedAt: patch.status === "started" ? null : patch.at,
      items: patch.status === "started"
        ? turn.items
        : turn.items.map((item) => ({
            ...item,
            status: item.status === "active" ? "completed" : item.status,
            updatedAt: patch.at
          }))
    }));
  }

  if (patch.kind === "content-delta" && patch.streamKind !== "assistant_text") {
    return patchButlerActivityItem(current, patch.turnId, patch.itemId, patch.at, {
      kind: patch.streamKind === "reasoning_text" || patch.streamKind === "reasoning_summary_text" ? "thinking" : "tool",
      title: patch.streamKind === "reasoning_text" || patch.streamKind === "reasoning_summary_text" ? "Thinking" : "Tool",
      textDelta: patch.delta,
      contentIndex: butlerContentIndex(patch.itemId),
      status: "active"
    });
  }

  if (patch.kind === "item-lifecycle") {
    return patchButlerActivityItem(current, patch.turnId, patch.itemId, patch.at, {
      kind: patch.itemType === "reasoning" ? "thinking" : "tool",
      title: patch.title ?? butlerActivityTitle(patch.itemType),
      text: patch.text,
      contentIndex: butlerContentIndex(patch.itemId),
      toolCallId: butlerToolCallId(patch.itemId),
      status: patch.status === "failed" ? "error" : patch.status === "completed" ? "completed" : "active"
    });
  }

  return current;
}

type ButlerMessage = ButlerLiveSnapshot["messages"][number];
type ButlerActivityTurnSnapshot = ButlerLiveSnapshot["activityTurns"][number];
type ButlerActivityItemSnapshot = ButlerActivityTurnSnapshot["items"][number];

function readButlerMessageText(current: ButlerLiveSnapshot, messageId: string): string {
  return current.messages.find((message) => message.id === messageId)?.text ?? "";
}

function removeCommittedPendingButlerMessage(current: ButlerLiveSnapshot, text: string, at: number): ButlerLiveSnapshot {
  const exactIndex = current.messages.findIndex((message) =>
    message.pending === true &&
    message.role.startsWith("user") &&
    message.text === text &&
    (at ?? message.at ?? 0) >= (message.at ?? 0) - 1000
  );
  const index = exactIndex >= 0 ? exactIndex : current.messages.findIndex((message) =>
    message.pending === true &&
    message.role.startsWith("user") &&
    (at ?? message.at ?? 0) >= (message.at ?? 0) - 1000
  );
  if (index < 0) {
    return current;
  }

  return {
    ...current,
    messages: current.messages.filter((_, messageIndex) => messageIndex !== index),
    messageCount: Math.max(0, current.messageCount - 1)
  };
}

function upsertButlerMessage(current: ButlerLiveSnapshot, message: ButlerMessage): ButlerLiveSnapshot {
  const messagesById = new Map(current.messages.map((entry) => [entry.id, entry]));
  const existing = messagesById.get(message.id);
  messagesById.set(message.id, {
    ...existing,
    ...message,
    text: message.text || existing?.text || "",
    at: existing?.at ?? message.at
  });

  return {
    ...current,
    messages: [...messagesById.values()].sort((left, right) => (left.at ?? 0) - (right.at ?? 0) || left.id.localeCompare(right.id)),
    messageCount: existing ? current.messageCount : current.messageCount + 1
  };
}

function createButlerActivityTurn(turnId: string, at: number): ButlerActivityTurnSnapshot {
  return {
    id: turnId,
    status: "active",
    startedAt: at,
    completedAt: null,
    items: []
  };
}

function patchButlerActivityTurn(
  current: ButlerLiveSnapshot,
  turnId: string,
  at: number,
  patchTurn: (turn: ButlerActivityTurnSnapshot) => ButlerActivityTurnSnapshot
): ButlerLiveSnapshot {
  const turnIndex = current.activityTurns.findIndex((turn) => turn.id === turnId);
  const turn = turnIndex >= 0 ? current.activityTurns[turnIndex] : createButlerActivityTurn(turnId, at);
  const patchedTurn = patchTurn(turn);
  const activityTurns = turnIndex >= 0
    ? current.activityTurns.map((entry, index) => index === turnIndex ? patchedTurn : entry)
    : [...current.activityTurns, patchedTurn];
  return {
    ...current,
    activityTurns: activityTurns.sort((left, right) => left.startedAt - right.startedAt)
  };
}

function butlerActivityTitle(itemType: ProviderRuntimeItemType): string {
  switch (itemType) {
    case "reasoning":
      return "Thinking";
    case "command_execution":
      return "Command";
    case "context_compaction":
      return "Compaction";
    default:
      return "Tool";
  }
}

function butlerContentIndex(itemId: string): number | null {
  const match = /:(?:thinking|content):(\d+)(?::|$)/.exec(itemId);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}

function butlerToolCallId(itemId: string): string | null {
  const match = /:tool:(.+)$/.exec(itemId);
  return match?.[1] ?? null;
}

function createButlerActivityItem(
  itemId: string,
  at: number,
  input: {
    kind: ButlerActivityItemSnapshot["kind"];
    title: string;
    contentIndex?: number | null;
    toolCallId?: string | null;
    status?: ButlerActivityItemSnapshot["status"];
  }
): ButlerActivityItemSnapshot {
  return {
    id: itemId,
    kind: input.kind,
    status: input.status ?? "active",
    title: input.title,
    text: "",
    at,
    updatedAt: at,
    contentIndex: input.contentIndex ?? null,
    toolCallId: input.toolCallId ?? null
  };
}

function patchButlerActivityItem(
  current: ButlerLiveSnapshot,
  turnId: string,
  itemId: string,
  at: number,
  input: {
    kind: ButlerActivityItemSnapshot["kind"];
    title: string;
    text?: string;
    textDelta?: string;
    contentIndex?: number | null;
    toolCallId?: string | null;
    status: ButlerActivityItemSnapshot["status"];
  }
): ButlerLiveSnapshot {
  return patchButlerActivityTurn(current, turnId, at, (turn) => {
    const itemIndex = turn.items.findIndex((item) => item.id === itemId);
    const item = itemIndex >= 0 ? turn.items[itemIndex] : createButlerActivityItem(itemId, at, input);
    const patchedItem: ButlerActivityItemSnapshot = {
      ...item,
      kind: item.kind || input.kind,
      title: input.title || item.title,
      text: input.text !== undefined ? input.text : `${item.text}${input.textDelta ?? ""}`,
      status: input.status,
      updatedAt: at,
      contentIndex: item.contentIndex ?? input.contentIndex ?? null,
      toolCallId: item.toolCallId ?? input.toolCallId ?? null
    };
    const items = itemIndex >= 0
      ? turn.items.map((entry, index) => index === itemIndex ? patchedItem : entry)
      : [...turn.items, patchedItem];
    return {
      ...turn,
      status: turn.status === "completed" ? turn.status : "active",
      items
    };
  });
}

function activityUpdatedAt(turn: ButlerLiveSnapshot["activityTurns"][number]): number {
  return Math.max(turn.completedAt ?? 0, turn.startedAt, ...turn.items.map((item) => item.updatedAt));
}

export function mergeButlerLiveSnapshots(current: ButlerLiveSnapshot | null, next: ButlerLiveSnapshot): ButlerLiveSnapshot {
  if (!current) {
    return next;
  }
  const currentServerOperatorMessages = current.messages.filter(isServerOperatorMessage);
  const shouldPreserveServerOperatorMessages = (next.pendingRevision ?? 0) < (current.pendingRevision ?? 0);
  if (next.messageCount < current.messageCount && next.messageCount + currentServerOperatorMessages.length < current.messageCount) {
    return next;
  }
  const currentMessages = new Map(current.messages.map((message) => [message.id, message]));
  const currentActivity = new Map(current.activityTurns.map((turn) => [turn.id, turn]));
  const nextMessageIds = new Set(next.messages.map((message) => message.id));
  const preservedPendingMessages = shouldPreserveServerOperatorMessages
    ? currentServerOperatorMessages.filter((message) =>
        !nextMessageIds.has(message.id) &&
        !next.messages.some((nextMessage) => nextMessage.role.startsWith("user") && nextMessage.text === message.text && (nextMessage.at ?? message.at ?? 0) >= (message.at ?? 0) - 1000)
      )
    : [];
  const messages = [
    ...next.messages.map((message) => {
      const currentMessage = currentMessages.get(message.id);
      return currentMessage && currentMessage.text.length > message.text.length ? currentMessage : message;
    }),
    ...preservedPendingMessages
  ].sort((left, right) => (left.at ?? 0) - (right.at ?? 0) || left.id.localeCompare(right.id));

  return {
    messages,
    messageCount: next.messageCount + preservedPendingMessages.length,
    pendingRevision: Math.max(current.pendingRevision ?? 0, next.pendingRevision ?? 0),
    activityTurns: next.activityTurns.map((turn) => {
      const currentTurn = currentActivity.get(turn.id);
      return currentTurn && activityUpdatedAt(currentTurn) > activityUpdatedAt(turn) ? currentTurn : turn;
    })
  };
}

function isServerOperatorMessage(message: ButlerMessage): boolean {
  return message.pending === true || message.id.startsWith("pending-operator-");
}

function threadTextSize(thread: CodexThreadDetail): number {
  return thread.turns.reduce((sum, turn) => sum + turn.items.reduce((itemSum, item) => itemSum + item.text.length, 0), 0);
}

export function mergeOpenThreadSnapshots(
  current: Record<string, CodexThreadDetail>,
  next: Record<string, CodexThreadDetail>
): Record<string, CodexThreadDetail> {
  const merged = { ...next };
  for (const [threadId, thread] of Object.entries(current)) {
    const incoming = next[threadId];
    if (incoming && (thread.updatedAt > incoming.updatedAt || (thread.updatedAt === incoming.updatedAt && threadTextSize(thread) > threadTextSize(incoming)))) {
      merged[threadId] = thread;
    }
  }
  return merged;
}

type ThreadTurn = CodexThreadDetail["turns"][number];
type ThreadItem = ThreadTurn["items"][number];

function threadItemType(itemType: ProviderRuntimeItemType, streamKind?: ProviderRuntimeContentStreamKind): string {
  if (streamKind === "assistant_text") return "agentMessage";
  if (streamKind === "command_output") return "commandExecution";
  if (streamKind === "file_change_output") return "fileChange";
  if (streamKind === "reasoning_text" || streamKind === "reasoning_summary_text") return "reasoning";
  if (streamKind === "plan_text") return "plan";

  switch (itemType) {
    case "assistant_message":
      return "agentMessage";
    case "user_message":
      return "userMessage";
    case "command_execution":
      return "commandExecution";
    case "file_change":
      return "fileChange";
    case "web_search":
      return "webSearch";
    case "context_compaction":
      return "contextCompaction";
    default:
      return itemType;
  }
}

function threadItemStatus(status: ProviderRuntimeItemStatus): string {
  return status === "in_progress" ? "started" : status;
}

function resolvedThreadItemType(currentType: string, nextType: string): string {
  return !currentType || currentType === "unknown" ? nextType : currentType;
}

function threadTurnStatus(status: "started" | ProviderRuntimeTurnState): string {
  return status === "started" ? "in_progress" : status;
}

function threadStatus(state: ProviderRuntimeThreadState): ThreadStatus {
  return state === "idle" ? "idle" : "active";
}

function createTurn(id: string, at: number): ThreadTurn {
  return {
    id,
    requestedReasoningEffort: null,
    status: "unknown",
    error: null,
    startedAt: at,
    completedAt: null,
    items: []
  };
}

function createItem(id: string, type: string, at: number): ThreadItem {
  return {
    id,
    type,
    status: "started",
    text: "",
    at,
    taskDurationMs: null
  };
}

export function applyThreadPatchSnapshot(
  current: Record<string, CodexThreadDetail>,
  patch: CodexThreadPatch
): Record<string, CodexThreadDetail> {
  const thread = current[patch.threadId];
  if (!thread) {
    return current;
  }

  if (patch.kind === "thread-state") {
    return {
      ...current,
      [patch.threadId]: {
        ...thread,
        status: threadStatus(patch.state),
        updatedAt: Math.max(thread.updatedAt, patch.at)
      }
    };
  }

  if (patch.kind === "token-usage") {
    return {
      ...current,
      [patch.threadId]: {
        ...thread,
        updatedAt: Math.max(thread.updatedAt, patch.at),
        contextUsage: {
          tokens: patch.tokens,
          contextWindow: patch.contextWindow,
          percent: patch.percent
        }
      }
    };
  }

  if (patch.kind === "runtime-message") {
    return {
      ...current,
      [patch.threadId]: {
        ...thread,
        updatedAt: Math.max(thread.updatedAt, patch.at),
        eventLog: [
          ...thread.eventLog,
          {
            at: patch.at,
            method: patch.tone === "error" ? "runtime.error" : "runtime.warning",
            summary: patch.message
          }
        ]
      }
    };
  }

  const turnIndex = thread.turns.findIndex((turn) => turn.id === patch.turnId);
  const turn = turnIndex >= 0 ? thread.turns[turnIndex] : createTurn(patch.turnId, patch.at);

  if (patch.kind === "turn-lifecycle") {
    const isComplete = patch.status !== "started";
    const patchedTurn = {
      ...turn,
      status: threadTurnStatus(patch.status),
      startedAt: Math.min(turn.startedAt || patch.at, patch.at),
      completedAt: isComplete ? patch.at : null
    };
    const turns = turnIndex >= 0 ? thread.turns.map((entry, index) => index === turnIndex ? patchedTurn : entry) : [...thread.turns, patchedTurn];
    return {
      ...current,
      [patch.threadId]: {
        ...thread,
        updatedAt: Math.max(thread.updatedAt, patch.at),
        status: isComplete ? thread.status : "active",
        turnCount: Math.max(thread.turnCount, turns.length),
        turns
      }
    };
  }

  const itemType = patch.kind === "content-delta"
    ? threadItemType(patch.itemType, patch.streamKind)
    : threadItemType(patch.itemType);
  const itemIndex = turn.items.findIndex((item) => item.id === patch.itemId);
  const item = itemIndex >= 0 ? turn.items[itemIndex] : createItem(patch.itemId, itemType, patch.at);

  if (patch.kind === "content-delta" && item.text.length >= patch.itemTextLength) {
    return current;
  }

  if (patch.kind === "item-lifecycle" && (patch.itemType === "assistant_message" || patch.itemType === "user_message") && !patch.text.trim()) {
    return current;
  }

  const patchedItem = patch.kind === "content-delta"
    ? {
        ...item,
        type: resolvedThreadItemType(item.type, itemType),
        status: "started",
        text: item.text + patch.delta,
        at: patch.at
      }
    : {
        ...item,
        type: resolvedThreadItemType(item.type, itemType),
        status: threadItemStatus(patch.status),
        text: patch.text || item.text,
        at: patch.at
      };
  const items = itemIndex >= 0 ? turn.items.map((entry, index) => index === itemIndex ? patchedItem : entry) : [...turn.items, patchedItem];
  const patchedTurn = { ...turn, status: "in_progress", items };
  const turns = turnIndex >= 0 ? thread.turns.map((entry, index) => index === turnIndex ? patchedTurn : entry) : [...thread.turns, patchedTurn];

  return {
    ...current,
    [patch.threadId]: {
      ...thread,
      updatedAt: Math.max(thread.updatedAt, patch.at),
      status: "active",
      turnCount: Math.max(thread.turnCount, turns.length),
      turns
    }
  };
}

async function getJsonWithTimeout<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BOOTSTRAP_REFRESH_TIMEOUT_MS);
  try {
    return await getJson<T>(url, {
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

function mergeBootstrapImages(images: ImageReference[]): void {
  const merged = new Map<string, ImageReference>();
  for (const image of images) {
    merged.set(image.id, image);
  }
  for (const image of imagesStore.getSnapshot()) {
    merged.set(image.id, image);
  }
  imagesStore.setSnapshot([...merged.values()]);
}

async function refreshBootstrap(
  includeImages = false
): Promise<{ bootstrap: BootstrapSnapshot; images: ImageReference[] | null }> {
  const [bootstrap, images] = await Promise.all([
    getJsonWithTimeout<BootstrapSnapshot>("/api/bootstrap"),
    includeImages || imagesStore.getSnapshot().length === 0
      ? getJsonWithTimeout<{ images: ImageReference[] }>("/api/images?limit=200").then((payload) => payload.images)
      : Promise.resolve(null)
  ]);

  return { bootstrap, images };
}

function applyBootstrapSnapshotIfCurrent(
  payload: { bootstrap: BootstrapSnapshot; images: ImageReference[] | null },
  requestedAt: number,
  forcedChannels: readonly BootstrapChannel[] = []
): void {
  if (payload.images) {
    mergeBootstrapImages(payload.images);
  }

  const appliedAt = Date.now();
  const channelsToApply = new Set<BootstrapChannel>([
    ...selectBootstrapChannelsToApply(lastStateEventAtByChannel, requestedAt),
    ...forcedChannels
  ]);
  lastBootstrapRefreshAt = appliedAt;
  for (const channel of channelsToApply) {
    lastStateEventAtByChannel[channel] = appliedAt;
    lastAppliedChannelVersion[channel] = Math.max(
      lastAppliedChannelVersion[channel],
      lastServerChannelVersion[channel]
    );
    if (channel === "shell") {
      shellStore.setSnapshot(payload.bootstrap.shell);
    } else if (channel === "butlerLive") {
      butlerLiveStore.setSnapshot(mergeButlerLiveSnapshots(butlerLiveStore.getSnapshot(), payload.bootstrap.butlerLive));
    } else if (channel === "runtime") {
      runtimeStore.setSnapshot(payload.bootstrap.runtime);
    } else {
      openThreadsStore.setSnapshot(mergeOpenThreadSnapshots(openThreadsStore.getSnapshot(), payload.bootstrap.openThreads));
    }
  }
}

function refreshLiveStateFromServer(
  includeImages = false,
  shouldApply?: () => boolean,
  forcedChannels: readonly BootstrapChannel[] = []
): Promise<void> {
  if (!includeImages && !shouldApply && forcedChannels.length === 0 && bootstrapRefreshInFlight) {
    return bootstrapRefreshInFlight;
  }

  const requestedAt = Date.now();
  lastBootstrapRefreshAt = requestedAt;
  const refresh = refreshBootstrap(includeImages).then((payload) => {
    if (shouldApply && !shouldApply()) {
      return;
    }

    applyBootstrapSnapshotIfCurrent(payload, requestedAt, forcedChannels);
  }).finally(() => {
    if (bootstrapRefreshInFlight === refresh) {
      bootstrapRefreshInFlight = null;
    }
  });

  if (!includeImages && !shouldApply && forcedChannels.length === 0) {
    bootstrapRefreshInFlight = refresh;
  }
  return refresh;
}

function getCurrentVisibilityState(): DocumentVisibilityState | "unknown" {
  if (typeof document === "undefined") {
    return "unknown";
  }
  return document.visibilityState;
}

function requestVisiblePageResync(
  minIntervalMs: number,
  forcedChannels: readonly BootstrapChannel[] = []
): void {
  if (typeof window === "undefined") {
    return;
  }

  const now = Date.now();
  const shouldForceStaleChannels = forcedChannels.length > 0;
  if (
    !shouldForceStaleChannels &&
    !shouldRefreshLiveStateOnPageEvent({
      now,
      lastRefreshAt: lastBootstrapRefreshAt,
      minIntervalMs,
      hasSnapshot: Boolean(shellStore.getSnapshot()),
      visibilityState: getCurrentVisibilityState()
    })
  ) {
    return;
  }

  if (shouldForceStaleChannels && getCurrentVisibilityState() === "hidden") {
    return;
  }

  void refreshLiveStateFromServer(false, undefined, forcedChannels).catch(handleVisiblePageResyncFailure);
}

function requestVersionGapResync(): void {
  const outdatedChannels = selectOutdatedBootstrapChannels(lastAppliedChannelVersion, lastServerChannelVersion);
  if (outdatedChannels.length === 0) {
    return;
  }

  requestVisiblePageResync(VERSION_GAP_RESYNC_MIN_INTERVAL_MS, outdatedChannels);
}

function handleVisiblePageResyncFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  scheduleReconnect(message);
}

function installPageResyncHandlers(): void {
  if (pageResyncHandlersInstalled || typeof window === "undefined") {
    return;
  }

  pageResyncHandlersInstalled = true;
  const resyncSoon = () => requestVisiblePageResync(FOREGROUND_RESYNC_MIN_INTERVAL_MS);
  window.addEventListener("focus", resyncSoon);
  window.addEventListener("pageshow", resyncSoon);
  window.addEventListener("online", resyncSoon);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") {
      resyncSoon();
    }
  });
  window.setInterval(
    () => {
      const minIntervalMs = transportStore.getSnapshot().connected
        ? VISIBLE_RESYNC_MIN_INTERVAL_MS
        : FOREGROUND_RESYNC_MIN_INTERVAL_MS;
      requestVisiblePageResync(minIntervalMs);
    },
    VISIBLE_RESYNC_CHECK_INTERVAL_MS
  );
}

function scheduleDisconnectNotice(reason: string, lastEventAt: number | null): void {
  if (disconnectNoticeTimer !== null || transportStore.getSnapshot().disconnected) {
    return;
  }

  disconnectNoticeTimer = window.setTimeout(() => {
    disconnectNoticeTimer = null;
    const current = transportStore.getSnapshot();
    if (!current.connected && current.reconnecting) {
      setTransportState({
        connected: false,
        disconnected: true,
        reconnecting: true,
        lastError: current.lastError ?? reason,
        lastEventAt
      });
    }
  }, DISCONNECT_NOTICE_DELAY_MS);
}

function scheduleReconnect(reason: string): void {
  closeEventSource();
  clearHeartbeatTimer();

  const current = transportStore.getSnapshot();
  setTransportState({
    connected: false,
    disconnected: current.disconnected,
    reconnecting: true,
    lastError: reason,
    lastEventAt: current.lastEventAt
  });
  scheduleDisconnectNotice(reason, current.lastEventAt);

  if (reconnectTimer !== null) {
    return;
  }

  const retryIndex = reconnectAttempt++;
  const baseDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** retryIndex);
  const jitter = Math.min(750, Math.round(baseDelay * 0.2 * Math.random()));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    openEventSource();
  }, baseDelay + jitter);
}

function openEventSource(): void {
  closeEventSource();
  clearHeartbeatTimer();
  clearReconnectTimer();

  const attemptId = ++connectionAttempt;
  const source = new EventSource(EVENT_STREAM_PATH);
  eventSource = source;
  const currentTransport = transportStore.getSnapshot();
  setTransportState({
    connected: false,
    disconnected: currentTransport.disconnected,
    reconnecting: true,
    lastError: currentTransport.disconnected ? currentTransport.lastError : null
  });
  heartbeatTimer = window.setTimeout(() => {
    if (eventSource === source && attemptId === connectionAttempt) {
      scheduleReconnect("Live updates stalled");
    }
  }, EVENT_SOURCE_CONNECT_TIMEOUT_MS);

  const isCurrentAttempt = () => eventSource === source && attemptId === connectionAttempt;
  const onEvent = <T>(channel: BootstrapChannel, storeSetter: (payload: T) => void) => (event: Event) => {
    if (!isCurrentAttempt()) {
      return;
    }

    const version = parseEventChannelVersion(event, channel);
    if (!shouldApplyChannelEvent(lastAppliedChannelVersion[channel], version)) {
      markTransportAlive();
      return;
    }

    markTransportAlive();
    lastStateEventAtByChannel[channel] = Date.now();
    if (version !== null) {
      applyChannelVersion(channel, version);
    }
    storeSetter(parseEventData<T>(event));
  };

  source.onopen = () => {
    if (!isCurrentAttempt()) {
      return;
    }

    markTransportAlive();
    bootstrapPromise = refreshLiveStateFromServer(false, isCurrentAttempt)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!isCurrentAttempt()) {
          return;
        }
        scheduleReconnect(message);
      });
  };

  source.addEventListener("shell", onEvent<ShellSnapshot>("shell", (payload) => shellStore.setSnapshot(payload)));
  source.addEventListener("butlerLive", onEvent<ButlerLiveSnapshot>("butlerLive", (payload) => butlerLiveStore.setSnapshot(mergeButlerLiveSnapshots(butlerLiveStore.getSnapshot(), payload))));
  source.addEventListener("butlerPatch", (event) => {
    if (!isCurrentAttempt()) {
      return;
    }
    const browserReceivedAt = Date.now();
    markTransportAlive();
    const patch = parseEventData<ButlerLivePatch>(event);
    butlerLiveStore.setSnapshot(applyButlerLivePatchSnapshot(butlerLiveStore.getSnapshot(), patch));
    queueButlerPatchTelemetry(patch.telemetry, browserReceivedAt, Date.now());
  });
  source.addEventListener("runtime", onEvent<RuntimeSnapshot>("runtime", (payload) => runtimeStore.setSnapshot(payload)));
  source.addEventListener("threads", onEvent<Record<string, CodexThreadDetail>>("threads", (payload) => openThreadsStore.setSnapshot(mergeOpenThreadSnapshots(openThreadsStore.getSnapshot(), payload))));
  source.addEventListener("threadPatch", (event) => {
    if (!isCurrentAttempt()) {
      return;
    }
    markTransportAlive();
    openThreadsStore.setSnapshot(applyThreadPatchSnapshot(openThreadsStore.getSnapshot(), parseEventData<CodexThreadPatch>(event)));
  });
  source.addEventListener("composerPrefill", (event) => {
    if (!isCurrentAttempt()) {
      return;
    }
    markTransportAlive();
    window.dispatchEvent(new CustomEvent<ComposerPrefill>("manor:composer-prefill", { detail: parseEventData<ComposerPrefill>(event) }));
  });
  source.addEventListener("toast", (event) => {
    if (!isCurrentAttempt()) {
      return;
    }

    markTransportAlive();
    serverToastStore.setSnapshot(parseEventData<ServerToastEvent>(event));
  });
  source.addEventListener("heartbeat", (event) => {
    if (!isCurrentAttempt()) {
      return;
    }
    markTransportAlive();
    updateServerChannelVersions(parseHeartbeatChannelVersions(event));
    requestVersionGapResync();
  });
  source.onerror = () => {
    if (!isCurrentAttempt()) {
      return;
    }

    scheduleReconnect("Live updates disconnected");
  };
}

function ensureStarted(): void {
  if (started) {
    return;
  }

  started = true;
  installPageResyncHandlers();
  bootstrapPromise = refreshLiveStateFromServer(true)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setTransportState({
        connected: false,
        disconnected: true,
        reconnecting: true,
        lastError: message
      });
      scheduleReconnect(message);
    });
  openEventSource();
}

function useStoreValue<T>(store: ReturnType<typeof createStore<T>>) {
  ensureStarted();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useShellSnapshot(): ShellSnapshot | null {
  return useStoreValue(shellStore);
}

export function useButlerLiveSnapshot(): ButlerLiveSnapshot | null {
  return useStoreValue(butlerLiveStore);
}

export function useRuntimeSnapshot(): RuntimeSnapshot | null {
  return useStoreValue(runtimeStore);
}

export function useKnownImages(): ImageReference[] {
  return useStoreValue(imagesStore);
}

export function useServerToastEvent(): ServerToastEvent | null {
  return useStoreValue(serverToastStore);
}

export function clearPendingManorRestartRequestSnapshot(shell: ShellSnapshot | null, requestId: string): ShellSnapshot | null {
  if (shell?.butler.pendingManorRestartRequest?.id !== requestId) {
    return shell;
  }
  return {
    ...shell,
    butler: {
      ...shell.butler,
      pendingManorRestartRequest: null
    }
  };
}

export function clearPendingManorRestartRequest(requestId: string): void {
  const current = shellStore.getSnapshot();
  const next = clearPendingManorRestartRequestSnapshot(current, requestId);
  if (next !== current) {
    shellStore.setSnapshot(next);
  }
}

export function mergeKnownImages(images: ImageReference[]): void {
  const next = new Map(imagesStore.getSnapshot().map((image) => [image.id, image]));
  for (const image of images) {
    next.set(image.id, image);
  }
  imagesStore.setSnapshot([...next.values()]);
}

export function useTransportState(): TransportState {
  return useStoreValue(transportStore);
}

export function useOpenThreads(): Record<string, CodexThreadDetail> {
  return useStoreValue(openThreadsStore);
}

export function useThreadDetail(threadId: string | null): CodexThreadDetail | null {
  const threads = useOpenThreads();

  useEffect(() => {
    if (!threadId || threads[threadId] || inflightThreadLoads.has(threadId)) {
      return;
    }

    const loadPromise = getJson<{ thread: CodexThreadDetail }>(`/api/threads/${encodeURIComponent(threadId)}`)
      .then((payload) => {
        openThreadsStore.setSnapshot({
          ...openThreadsStore.getSnapshot(),
          [threadId]: payload.thread
        });
      })
      .finally(() => {
        inflightThreadLoads.delete(threadId);
      });

    inflightThreadLoads.set(threadId, loadPromise);
  }, [threadId, threads]);

  return threadId ? threads[threadId] ?? null : null;
}

export async function waitForBootstrap(): Promise<void> {
  ensureStarted();
  await bootstrapPromise;
}


export const __liveStateTestHooks = {
  disconnectNoticeDelayMs: DISCONNECT_NOTICE_DELAY_MS,
  getTransportSnapshot: () => transportStore.getSnapshot(),
  handleVisiblePageResyncFailureForTest: handleVisiblePageResyncFailure,
  markTransportAliveForTest: markTransportAlive,
  scheduleReconnectForTest: scheduleReconnect,
  resetForTest: () => {
    closeEventSource();
    clearReconnectTimer();
    clearHeartbeatTimer();
    clearDisconnectNoticeTimer();
    started = false;
    bootstrapPromise = null;
    bootstrapRefreshInFlight = null;
    connectionAttempt = 0;
    reconnectAttempt = 0;
    lastBootstrapRefreshAt = 0;
    pageResyncHandlersInstalled = false;
    for (const channel of BOOTSTRAP_CHANNELS) {
      lastStateEventAtByChannel[channel] = 0;
      lastAppliedChannelVersion[channel] = 0;
      lastServerChannelVersion[channel] = 0;
    }
    inflightThreadLoads.clear();
    shellStore.setSnapshot(null);
    butlerLiveStore.setSnapshot(null);
    runtimeStore.setSnapshot(null);
    openThreadsStore.setSnapshot({});
    imagesStore.setSnapshot([]);
    serverToastStore.setSnapshot(null);
    transportStore.setSnapshot({
      connected: false,
      disconnected: false,
      reconnecting: false,
      lastEventAt: null,
      lastError: null
    });
  }
};
