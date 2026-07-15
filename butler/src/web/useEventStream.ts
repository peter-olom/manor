import { useEffect, useRef, useState } from "react";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";

export type ComposerPrefillPayload = {
  id: string;
  target: { kind: "butler" } | { kind: "thread"; threadId: string };
  text: string;
  attachment?: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: number;
    url: string;
  };
};

export type ToastPayload = {
  id: string;
  message: string;
  tone: "success" | "error" | "info";
  duration: number;
};

export type WorkerThreadRefreshedPayload = {
  threadId: string;
};

export type EventStreamHandlers = {
  onButlerPatch?: (patch: ProviderRuntimeLivePatch) => void;
  onThreadPatch?: (patch: ProviderRuntimeLivePatch) => void;
  onComposerPrefill?: (payload: ComposerPrefillPayload) => void;
  onToast?: (payload: ToastPayload) => void;
  onWorkerThreadRefreshed?: (payload: WorkerThreadRefreshedPayload) => void;
  onError?: (error: Event) => void;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type UseEventStreamResult = {
  connected: boolean;
  hasConnected: boolean;
  lastEventAt: number | null;
};

export function useEventStream(handlers: EventStreamHandlers): UseEventStreamResult {
  const [connected, setConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const open = () => {
      if (cancelled) return;
      source = new EventSource("/api/events?state=");

      source.addEventListener("open", () => {
        attempt = 0;
        setConnected(true);
        setHasConnected(true);
      });

      const handlePatch = (event: MessageEvent, channel: "butlerPatch" | "threadPatch") => {
        try {
          const patch = JSON.parse(event.data) as ProviderRuntimeLivePatch;
          if (!patch || typeof patch !== "object" || typeof patch.kind !== "string") {
            return;
          }
          setLastEventAt(Date.now());
          if (channel === "butlerPatch") {
            handlersRef.current.onButlerPatch?.(patch);
          } else {
            handlersRef.current.onThreadPatch?.(patch);
          }
        } catch {
          // ignore malformed payload
        }
      };

      source.addEventListener("butlerPatch", (event) => handlePatch(event as MessageEvent, "butlerPatch"));
      source.addEventListener("threadPatch", (event) => handlePatch(event as MessageEvent, "threadPatch"));

      const handleJsonEvent = <T,>(event: MessageEvent, handler: ((payload: T) => void) | undefined) => {
        try {
          const payload = JSON.parse(event.data) as T;
          handler?.(payload);
          setLastEventAt(Date.now());
        } catch {
          // ignore malformed payload
        }
      };

      source.addEventListener("composerPrefill", (event) => handleJsonEvent(event as MessageEvent, handlersRef.current.onComposerPrefill));
      source.addEventListener("toast", (event) => handleJsonEvent(event as MessageEvent, handlersRef.current.onToast));
      source.addEventListener("workerThreadRefreshed", (event) => handleJsonEvent(event as MessageEvent, handlersRef.current.onWorkerThreadRefreshed));

      source.addEventListener("error", (event) => {
        setConnected(false);
        handlersRef.current.onError?.(event);
        source?.close();
        source = null;
        if (cancelled) return;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(open, delay);
      });
    };

    open();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, []);

  return { connected, hasConnected, lastEventAt };
}
