import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { getJson } from "./api";
import type { WorkerProofRecord } from "./WorkerPane";
import { mergeWorkerThreadPages, type WorkerThread } from "./worker-timeline";
import type { PairWorkerThreadResponse } from "../shared/pairing";

const WORKER_PAGE_SIZE = 10;

export type WorkerHistoryRequestIdentity = {
  pairId: string | null;
  threadId: string | null;
  generation: number;
  requestId: number;
};

export function isCurrentWorkerHistoryRequest(
  request: WorkerHistoryRequestIdentity,
  current: WorkerHistoryRequestIdentity
): boolean {
  return request.pairId === current.pairId
    && request.threadId === current.threadId
    && request.generation === current.generation
    && request.requestId === current.requestId;
}

type WorkerThreadPage = {
  thread: WorkerThread | null;
  proofRecords: WorkerProofRecord[];
};

async function fetchWorkerThreadPage(pairId: string, before: number | null = null): Promise<WorkerThreadPage> {
  const query = before === null ? `limit=${WORKER_PAGE_SIZE}` : `before=${before}&limit=${WORKER_PAGE_SIZE}`;
  const payload = await getJson<PairWorkerThreadResponse>(`/api/pairs/${encodeURIComponent(pairId)}/worker-thread?${query}`);
  return {
    thread: (payload.thread as WorkerThread | null) ?? null,
    proofRecords: Array.isArray(payload.proofRecords) ? payload.proofRecords as WorkerProofRecord[] : []
  };
}

export function useWorkerThreadHistory(pairId: string | null, threadId: string | null, onError: (message: string) => void) {
  const [thread, setThread] = useState<WorkerThread | null>(null);
  const [proofState, setProofState] = useState<{
    pairId: string;
    threadId: string | null;
    generation: number;
    records: WorkerProofRecord[];
  } | null>(null);
  const [loadedPairId, setLoadedPairId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const latestRequestIdRef = useRef(0);
  const olderRequestIdRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const selectionRef = useRef({ pairId, threadId });
  selectionRef.current = { pairId, threadId };

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    latestRequestIdRef.current += 1;
    olderRequestIdRef.current += 1;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!pairId) {
      setThread(null); setProofState(null); setLoadedPairId(null); setLoading(false);
      return;
    }
    let cancelled = false;
    setThread(null); setProofState(null); setLoadedPairId(pairId); setLoading(true);
    const refresh = async () => {
      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      const request = { pairId, threadId, generation, requestId };
      try {
        const page = await fetchWorkerThreadPage(pairId);
        const nextThread = page.thread;
        const current = { ...selectionRef.current, generation: generationRef.current, requestId: latestRequestIdRef.current };
        if (!cancelled && isCurrentWorkerHistoryRequest(request, current) && (!nextThread || !threadId || nextThread.id === threadId)) {
          startTransition(() => {
            setThread((value) => {
              const active = { ...selectionRef.current, generation: generationRef.current, requestId: latestRequestIdRef.current };
              if (!isCurrentWorkerHistoryRequest(request, active)) return value;
              return nextThread?.id && value?.id && nextThread.id !== value.id ? value : mergeWorkerThreadPages(value, nextThread);
            });
            setProofState((currentProofs) => {
              const active = { ...selectionRef.current, generation: generationRef.current, requestId: latestRequestIdRef.current };
              if (!isCurrentWorkerHistoryRequest(request, active)) return currentProofs;
              const records = new Map((currentProofs?.generation === generation ? currentProofs.records : []).map((proof) => [proof.id, proof]));
              for (const proof of page.proofRecords) records.set(proof.id, proof);
              return { pairId, threadId, generation, records: [...records.values()] };
            });
            setLoading(false);
          });
        }
      } catch {
        const current = { ...selectionRef.current, generation: generationRef.current, requestId: latestRequestIdRef.current };
        if (!cancelled && isCurrentWorkerHistoryRequest(request, current)) setLoading(false);
      }
    };
    const requestRefresh = () => { void refresh(); };
    refreshRef.current = requestRefresh;
    void refresh();
    const interval = window.setInterval(requestRefresh, 15_000);
    return () => {
      cancelled = true; window.clearInterval(interval);
      if (generationRef.current === generation) generationRef.current += 1;
      if (refreshRef.current === requestRefresh) refreshRef.current = null;
    };
  }, [pairId, threadId]);

  const requestRefresh = useCallback((urgent: boolean) => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    if (urgent) { refreshRef.current?.(); return; }
    refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; refreshRef.current?.(); }, 50);
  }, []);

  const loadOlder = useCallback(async () => {
    if (!pairId || !thread?.hasMore || loadingOlderRef.current) return;
    const requestId = olderRequestIdRef.current + 1;
    olderRequestIdRef.current = requestId;
    const request = { pairId, threadId, generation: generationRef.current, requestId };
    const requestedThreadId = thread.id;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const response = await fetchWorkerThreadPage(pairId, thread.loadedStart ?? 0);
      const page = response.thread;
      const currentRequest = { ...selectionRef.current, generation: generationRef.current, requestId: olderRequestIdRef.current };
      if (!isCurrentWorkerHistoryRequest(request, currentRequest) || (page && page.id !== requestedThreadId)) return;
      setThread((current) => {
        const active = { ...selectionRef.current, generation: generationRef.current, requestId: olderRequestIdRef.current };
        if (!isCurrentWorkerHistoryRequest(request, active) || current?.id !== requestedThreadId) return current;
        return mergeWorkerThreadPages(current, page);
      });
      setProofState((currentProofs) => {
        const active = { ...selectionRef.current, generation: generationRef.current, requestId: olderRequestIdRef.current };
        if (!isCurrentWorkerHistoryRequest(request, active)) return currentProofs;
        const records = new Map((currentProofs?.generation === request.generation ? currentProofs.records : []).map((proof) => [proof.id, proof]));
        for (const proof of response.proofRecords) records.set(proof.id, proof);
        return { pairId, threadId, generation: request.generation, records: [...records.values()] };
      });
    } catch (error) {
      const currentRequest = { ...selectionRef.current, generation: generationRef.current, requestId: olderRequestIdRef.current };
      if (isCurrentWorkerHistoryRequest(request, currentRequest)) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      const currentRequest = { ...selectionRef.current, generation: generationRef.current, requestId: olderRequestIdRef.current };
      if (isCurrentWorkerHistoryRequest(request, currentRequest)) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [onError, pairId, thread, threadId]);

  useEffect(() => () => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
  }, []);

  return {
    thread: loadedPairId === pairId ? thread : null,
    proofRecords: loadedPairId === pairId
      && proofState?.pairId === pairId
      && proofState.threadId === threadId
      && proofState.generation === generationRef.current
      ? proofState.records
      : [],
    loading: Boolean(pairId && (loadedPairId !== pairId || loading)),
    loadingOlder,
    loadOlder,
    requestRefresh
  };
}
