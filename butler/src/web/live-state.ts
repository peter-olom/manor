import { useEffect, useSyncExternalStore } from "react";

import { getJson } from "./api";
import type {
  BootstrapSnapshot,
  ButlerLiveSnapshot,
  CodexThreadDetail,
  ImageReference,
  RuntimeSnapshot,
  ServerToastEvent,
  ShellSnapshot,
  TransportState
} from "./types";

type Listener = () => void;

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
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let connectionAttempt = 0;
let reconnectAttempt = 0;
let lastStateEventAt = 0;
const inflightThreadLoads = new Map<string, Promise<void>>();
const EVENT_STREAM_PATH = "/api/events";
const HEARTBEAT_TIMEOUT_MS = 45_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;

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
}

function parseEventData<T>(event: Event): T {
  return JSON.parse((event as MessageEvent<string>).data) as T;
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
    getJson<BootstrapSnapshot>("/api/bootstrap"),
    includeImages || imagesStore.getSnapshot().length === 0
      ? getJson<{ images: ImageReference[] }>("/api/images?limit=200").then((payload) => payload.images)
      : Promise.resolve(null)
  ]);

  return { bootstrap, images };
}

function applyBootstrapSnapshot(payload: { bootstrap: BootstrapSnapshot; images: ImageReference[] | null }): void {
  if (payload.images) {
    mergeBootstrapImages(payload.images);
  }

  lastStateEventAt = Date.now();
  handleBootstrap(payload.bootstrap);
}

function applyBootstrapSnapshotIfCurrent(
  payload: { bootstrap: BootstrapSnapshot; images: ImageReference[] | null },
  requestedAt: number
): void {
  if (lastStateEventAt > requestedAt) {
    if (payload.images) {
      mergeBootstrapImages(payload.images);
    }
    return;
  }

  applyBootstrapSnapshot(payload);
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

  const isCurrentAttempt = () => eventSource === source && attemptId === connectionAttempt;
  const onEvent = <T>(storeSetter: (payload: T) => void) => (event: Event) => {
    if (!isCurrentAttempt()) {
      return;
    }

    markTransportAlive();
    lastStateEventAt = Date.now();
    storeSetter(parseEventData<T>(event));
  };

  source.onopen = () => {
    if (!isCurrentAttempt()) {
      return;
    }

    markTransportAlive();
    const requestedAt = Date.now();
    bootstrapPromise = refreshBootstrap(false)
      .then((payload) => {
        if (!isCurrentAttempt()) {
          return;
        }

        applyBootstrapSnapshotIfCurrent(payload, requestedAt);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!isCurrentAttempt()) {
          return;
        }
        scheduleReconnect(message);
      });
  };

  source.addEventListener("shell", onEvent<ShellSnapshot>((payload) => shellStore.setSnapshot(payload)));
  source.addEventListener("butlerLive", onEvent<ButlerLiveSnapshot>((payload) => butlerLiveStore.setSnapshot(payload)));
  source.addEventListener("runtime", onEvent<RuntimeSnapshot>((payload) => runtimeStore.setSnapshot(payload)));
  source.addEventListener("threads", onEvent<Record<string, CodexThreadDetail>>((payload) => openThreadsStore.setSnapshot(payload)));
  source.addEventListener("toast", onEvent<ServerToastEvent>((payload) => serverToastStore.setSnapshot(payload)));
  source.addEventListener("heartbeat", () => {
    if (!isCurrentAttempt()) {
      return;
    }
    markTransportAlive();
  });
  source.onerror = () => {
    if (!isCurrentAttempt()) {
      return;
    }

    scheduleReconnect("Live updates disconnected");
  };
}

function handleBootstrap(data: BootstrapSnapshot): void {
  shellStore.setSnapshot(data.shell);
  butlerLiveStore.setSnapshot(data.butlerLive);
  runtimeStore.setSnapshot(data.runtime);
  openThreadsStore.setSnapshot(data.openThreads);
  markTransportAlive();
}

function ensureStarted(): void {
  if (started) {
    return;
  }

  started = true;
  const requestedAt = Date.now();
  bootstrapPromise = refreshBootstrap(true)
    .then((payload) => {
      applyBootstrapSnapshotIfCurrent(payload, requestedAt);
    })
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
