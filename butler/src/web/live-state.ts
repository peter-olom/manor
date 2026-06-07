import { useEffect, useSyncExternalStore } from "react";

import { getJson } from "./api";
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
const FOREGROUND_RESYNC_MIN_INTERVAL_MS = 3_000;
const VISIBLE_RESYNC_MIN_INTERVAL_MS = 30_000;
const VISIBLE_RESYNC_CHECK_INTERVAL_MS = 10_000;
const VERSION_GAP_RESYNC_MIN_INTERVAL_MS = 1_000;
const BOOTSTRAP_CHANNELS: readonly BootstrapChannel[] = ["shell", "butlerLive", "runtime", "threads"];

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
  const messagesById = new Map(current.messages.map((message) => [message.id, message]));
  for (const message of patch.messages ?? []) {
    messagesById.set(message.id, message);
  }
  const activityById = new Map(current.activityTurns.map((turn) => [turn.id, turn]));
  for (const turn of patch.activityTurns ?? []) {
    activityById.set(turn.id, turn);
  }
  return {
    messages: [...messagesById.values()].sort((left, right) => (left.at ?? 0) - (right.at ?? 0) || left.id.localeCompare(right.id)),
    messageCount: Math.max(current.messageCount, patch.messageCount),
    activityTurns: [...activityById.values()].sort((left, right) => left.startedAt - right.startedAt)
  };
}

function activityUpdatedAt(turn: ButlerLiveSnapshot["activityTurns"][number]): number {
  return Math.max(turn.completedAt ?? 0, turn.startedAt, ...turn.items.map((item) => item.updatedAt));
}

export function mergeButlerLiveSnapshots(current: ButlerLiveSnapshot | null, next: ButlerLiveSnapshot): ButlerLiveSnapshot {
  if (!current || next.messageCount < current.messageCount) {
    return next;
  }
  const currentMessages = new Map(current.messages.map((message) => [message.id, message]));
  const currentActivity = new Map(current.activityTurns.map((turn) => [turn.id, turn]));
  return {
    messages: next.messages.map((message) => {
      const currentMessage = currentMessages.get(message.id);
      return currentMessage && currentMessage.text.length > message.text.length ? currentMessage : message;
    }),
    messageCount: next.messageCount,
    activityTurns: next.activityTurns.map((turn) => {
      const currentTurn = currentActivity.get(turn.id);
      return currentTurn && activityUpdatedAt(currentTurn) > activityUpdatedAt(turn) ? currentTurn : turn;
    })
  };
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

export function applyThreadPatchSnapshot(
  current: Record<string, CodexThreadDetail>,
  patch: CodexThreadPatch
): Record<string, CodexThreadDetail> {
  const thread = current[patch.threadId];
  if (!thread || patch.kind !== "item-delta") {
    return current;
  }
  const turnIndex = thread.turns.findIndex((turn) => turn.id === patch.turnId);
  const turn = turnIndex >= 0 ? thread.turns[turnIndex] : { id: patch.turnId, requestedReasoningEffort: null, status: "unknown", error: null, startedAt: patch.at, completedAt: null, items: [] };
  const itemIndex = turn.items.findIndex((item) => item.id === patch.itemId);
  const item = itemIndex >= 0 ? turn.items[itemIndex] : { id: patch.itemId, type: patch.itemType, status: "started", text: "", at: patch.at, taskDurationMs: null };
  if (item.text.length >= patch.itemTextLength) {
    return current;
  }
  const patchedItem = { ...item, type: item.type || patch.itemType, status: "started", text: item.text + patch.delta, at: patch.at };
  const items = itemIndex >= 0 ? turn.items.map((entry, index) => index === itemIndex ? patchedItem : entry) : [...turn.items, patchedItem];
  const patchedTurn = { ...turn, items };
  const turns = turnIndex >= 0 ? thread.turns.map((entry, index) => index === turnIndex ? patchedTurn : entry) : [...thread.turns, patchedTurn];
  return { ...current, [patch.threadId]: { ...thread, updatedAt: Math.max(thread.updatedAt, patch.at), status: "active", turns } };
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

  void refreshLiveStateFromServer(false, undefined, forcedChannels).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setTransportState({
      connected: false,
      disconnected: true,
      reconnecting: true,
      lastError: message
    });
    scheduleReconnect(message);
  });
}

function requestVersionGapResync(): void {
  const outdatedChannels = selectOutdatedBootstrapChannels(lastAppliedChannelVersion, lastServerChannelVersion);
  if (outdatedChannels.length === 0) {
    return;
  }

  requestVisiblePageResync(VERSION_GAP_RESYNC_MIN_INTERVAL_MS, outdatedChannels);
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

function scheduleReconnect(reason: string): void {
  closeEventSource();
  clearHeartbeatTimer();

  const current = transportStore.getSnapshot();
  setTransportState({
    connected: false,
    disconnected: true,
    reconnecting: true,
    lastError: reason,
    lastEventAt: current.lastEventAt
  });

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
  setTransportState({
    connected: false,
    disconnected: false,
    reconnecting: true,
    lastError: null
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
    markTransportAlive();
    butlerLiveStore.setSnapshot(applyButlerLivePatchSnapshot(butlerLiveStore.getSnapshot(), parseEventData<ButlerLivePatch>(event)));
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
