import { useEffect, useRef, useState } from "react";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";

export type EventStreamInitialPayload = {
  shell?: unknown;
  butlerLive?: unknown;
  runtime?: unknown;
  threads?: unknown;
};

export type EventStreamHandlers = {
  onButlerPatch?: (patch: ProviderRuntimeLivePatch) => void;
  onThreadPatch?: (patch: ProviderRuntimeLivePatch) => void;
  onInitial?: (payload: EventStreamInitialPayload) => void;
  onError?: (error: Event) => void;
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type UseEventStreamResult = {
  connected: boolean;
  lastEventAt: number | null;
};

export function useEventStream(handlers: EventStreamHandlers): UseEventStreamResult {
  const [connected, setConnected] = useState(false);
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
      source = new EventSource("/api/events");

      source.addEventListener("open", () => {
        attempt = 0;
        setConnected(true);
      });

      const handlePatch = (event: MessageEvent, channel: "butlerPatch" | "threadPatch") => {
        try {
          const patch = JSON.parse(event.data) as ProviderRuntimeLivePatch;
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

      const handleInitial = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as EventStreamInitialPayload;
          handlersRef.current.onInitial?.(payload);
        } catch {
          // ignore malformed payload
        }
      };

      source.addEventListener("shell", handleInitial);
      source.addEventListener("butlerLive", handleInitial);
      source.addEventListener("runtime", handleInitial);
      source.addEventListener("threads", handleInitial);

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

  return { connected, lastEventAt };
}
