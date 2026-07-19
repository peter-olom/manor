import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { getJson, postJson } from "./api";
import { ManorRestartDialog } from "./ManorRestartDialog";
import { ManorRestartProgressDialog } from "./ManorRestartProgressDialog";
import { reconcileClearedManorRestartRequest, type ClearedManorRestartRequest } from "./pair-selection";
import type { ManorRestartProgressView } from "../shared/manor-restart";
import type { PairDetail } from "../shared/pairing";

type ProgressResponse = { progress: ManorRestartProgressView | null };
type AuthorizationAttempt = { pairId: string; requestId: string; generation: number };

export function useManorRestartApproval(
  pair: PairDetail | null,
  setPair: Dispatch<SetStateAction<PairDetail | null>>,
  connection: { connected: boolean; hasConnected: boolean }
): { reconcilePair: (pair: PairDetail) => PairDetail; dialog: ReactNode } {
  const clearedRef = useRef<ClearedManorRestartRequest | null>(null);
  const [progress, setProgressState] = useState<ManorRestartProgressView | null>(null);
  const [statusReachable, setStatusReachable] = useState<boolean | null>(null);
  const [recoveryUntil, setRecoveryUntilState] = useState<number | null>(null);
  const [hadDisconnect, setHadDisconnect] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const authorizationAttempt = useRef<AuthorizationAttempt | null>(null);
  const progressRef = useRef<ManorRestartProgressView | null>(null);
  const recoveryUntilRef = useRef<number | null>(null);
  const pairId = pair?.id ?? null;
  const requestId = pair?.pendingManorRestartRequest?.id ?? null;
  const activePairIdRef = useRef<string | null>(pairId);
  const activeRequestIdRef = useRef<string | null>(requestId);
  activePairIdRef.current = pairId;
  activeRequestIdRef.current = requestId;

  const setProgress = useCallback((next: ManorRestartProgressView | null) => {
    progressRef.current = next;
    setProgressState(next);
  }, []);

  const setRecoveryUntil = useCallback((next: number | null) => {
    recoveryUntilRef.current = next;
    setRecoveryUntilState(next);
  }, []);

  const clearPendingRequest = useCallback((targetPairId: string, targetRequestId: string) => {
    clearedRef.current = { pairId: targetPairId, requestId: targetRequestId };
    setPair((current) => current?.id === targetPairId
      ? { ...current, pendingManorRestartRequest: current.pendingManorRestartRequest?.id === targetRequestId ? null : current.pendingManorRestartRequest }
      : current);
  }, [setPair]);

  const refreshProgress = useCallback(async () => {
    if (!pairId) return;
    const targetPairId = pairId;
    const generation = ++refreshGeneration.current;
    try {
      const response = await getJson<ProgressResponse>(`/api/pairs/${encodeURIComponent(targetPairId)}/manor-restart-progress`);
      if (activePairIdRef.current !== targetPairId || generation !== refreshGeneration.current) return;
      setStatusReachable(true);
      if (response.progress) {
        setProgress(response.progress);
        setRecoveryUntil(null);
        clearPendingRequest(targetPairId, response.progress.requestId);
      } else {
        const deadline = recoveryUntilRef.current;
        if (!deadline || Date.now() >= deadline) {
          setProgress(null);
          setRecoveryUntil(null);
        }
      }
    } catch {
      if (activePairIdRef.current === targetPairId && generation === refreshGeneration.current) {
        setStatusReachable(false);
      }
    }
  }, [clearPendingRequest, pairId, setProgress, setRecoveryUntil]);

  useEffect(() => {
    refreshGeneration.current += 1;
    actionGeneration.current += 1;
    authorizationAttempt.current = null;
    setProgress(null);
    setStatusReachable(null);
    setRecoveryUntil(null);
    setHadDisconnect(false);
    setAcknowledging(false);
    setActionError(null);
    if (pairId) void refreshProgress();
  }, [pairId, refreshProgress, setProgress, setRecoveryUntil]);

  useEffect(() => {
    if (!pairId || (!progress && !recoveryUntil)) return;
    const interval = window.setInterval(() => void refreshProgress(), 1500);
    return () => window.clearInterval(interval);
  }, [pairId, progress, recoveryUntil, refreshProgress]);

  useEffect(() => {
    if ((progress || recoveryUntil) && connection.hasConnected && !connection.connected) {
      setHadDisconnect(true);
    }
  }, [connection.connected, connection.hasConnected, progress, recoveryUntil]);

  const reconcilePair = useCallback((nextPair: PairDetail): PairDetail => {
    const reconciled = reconcileClearedManorRestartRequest(nextPair, clearedRef.current);
    clearedRef.current = reconciled.cleared;
    return reconciled.pair;
  }, []);

  const request = pair?.pendingManorRestartRequest ?? null;
  const dialog = pair && progress ? (
    <ManorRestartProgressDialog
      progress={progress}
      connected={connection.connected}
      hasConnected={connection.hasConnected}
      hadDisconnect={hadDisconnect}
      statusReachable={statusReachable}
      acknowledging={acknowledging}
      actionError={actionError}
      onRetry={() => void refreshProgress()}
      onAcknowledge={() => {
        if (acknowledging) return;
        const targetPairId = pair.id;
        const targetRequestId = progress.requestId;
        const targetRunId = progress.runId;
        const generation = ++actionGeneration.current;
        refreshGeneration.current += 1;
        setAcknowledging(true);
        setActionError(null);
        void postJson(`/api/pairs/${encodeURIComponent(targetPairId)}/manor-restart-progress/${encodeURIComponent(targetRequestId)}/acknowledge`, {})
          .then(() => {
            const activeProgress = progressRef.current;
            if (activePairIdRef.current !== targetPairId || generation !== actionGeneration.current) return;
            if (activeProgress?.requestId !== targetRequestId || activeProgress.runId !== targetRunId) return;
            refreshGeneration.current += 1;
            setProgress(null);
            setHadDisconnect(false);
          })
          .catch((error) => {
            if (activePairIdRef.current === targetPairId && generation === actionGeneration.current) {
              setActionError(error instanceof Error ? error.message : String(error));
            }
          })
          .finally(() => {
            if (activePairIdRef.current === targetPairId && generation === actionGeneration.current) {
              setAcknowledging(false);
            }
          });
      }}
    />
  ) : pair && request ? (
    <ManorRestartDialog
      key={request.id}
      pairId={pair.id}
      request={request}
      onAuthorizationStarted={() => {
        const generation = ++actionGeneration.current;
        refreshGeneration.current += 1;
        authorizationAttempt.current = { pairId: pair.id, requestId: request.id, generation };
        setRecoveryUntil(Date.now() + 20_000);
        setActionError(null);
      }}
      onAuthorized={(nextProgress) => {
        const attempt = authorizationAttempt.current;
        if (!attempt || activePairIdRef.current !== attempt.pairId || activeRequestIdRef.current !== attempt.requestId) return;
        if (attempt.generation !== actionGeneration.current || nextProgress.requestId !== attempt.requestId) return;
        refreshGeneration.current += 1;
        setProgress(nextProgress);
        setStatusReachable(null);
        setRecoveryUntil(null);
      }}
      onCleared={() => {
        if (activePairIdRef.current === pair.id) clearPendingRequest(pair.id, request.id);
      }}
    />
  ) : null;
  return { reconcilePair, dialog };
}
