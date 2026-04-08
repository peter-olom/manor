import { useEffect, useSyncExternalStore } from "react";

import { getJson } from "./api";
import type {
  BootstrapSnapshot,
  ButlerLiveSnapshot,
  CodexThreadDetail,
  ImageReference,
  RuntimeSnapshot,
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
const transportStore = createStore<TransportState>({ connected: false, disconnected: false });

let started = false;
let eventSource: EventSource | null = null;
let bootstrapPromise: Promise<void> | null = null;
const inflightThreadLoads = new Map<string, Promise<void>>();

function setTransportState(nextValue: TransportState): void {
  const current = transportStore.getSnapshot();
  if (current.connected === nextValue.connected && current.disconnected === nextValue.disconnected) {
    return;
  }
  transportStore.setSnapshot(nextValue);
}

function handleBootstrap(data: BootstrapSnapshot): void {
  shellStore.setSnapshot(data.shell);
  butlerLiveStore.setSnapshot(data.butlerLive);
  runtimeStore.setSnapshot(data.runtime);
  openThreadsStore.setSnapshot(data.openThreads);
  setTransportState({ connected: true, disconnected: false });
}

function ensureStarted(): void {
  if (started) {
    return;
  }

  started = true;
  bootstrapPromise = Promise.all([
    getJson<BootstrapSnapshot>("/api/bootstrap").then(handleBootstrap),
    getJson<{ images: ImageReference[] }>("/api/images?limit=200").then((payload) => {
      imagesStore.setSnapshot(payload.images);
    })
  ])
    .then(() => undefined)
    .catch(() => {
      setTransportState({ connected: false, disconnected: true });
    });

  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => {
    setTransportState({ connected: true, disconnected: false });
  };
  eventSource.addEventListener("shell", (event) => {
    setTransportState({ connected: true, disconnected: false });
    shellStore.setSnapshot(JSON.parse((event as MessageEvent<string>).data));
  });
  eventSource.addEventListener("butlerLive", (event) => {
    setTransportState({ connected: true, disconnected: false });
    butlerLiveStore.setSnapshot(JSON.parse((event as MessageEvent<string>).data));
  });
  eventSource.addEventListener("runtime", (event) => {
    setTransportState({ connected: true, disconnected: false });
    runtimeStore.setSnapshot(JSON.parse((event as MessageEvent<string>).data));
  });
  eventSource.addEventListener("threads", (event) => {
    setTransportState({ connected: true, disconnected: false });
    openThreadsStore.setSnapshot(JSON.parse((event as MessageEvent<string>).data));
  });
  eventSource.addEventListener("heartbeat", () => {
    setTransportState({ connected: true, disconnected: false });
  });
  eventSource.onerror = () => {
    setTransportState({ connected: false, disconnected: true });
  };
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
