import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import type { PairDetail, PairWorkerSupervision } from "../shared/pairing";
import { postJson } from "./api";

export function useReviewCycleLimit(
  pair: PairDetail | null,
  setPair: Dispatch<SetStateAction<PairDetail | null>>,
  setError: Dispatch<SetStateAction<string | null>>
) {
  const [pending, setPending] = useState(false);
  const workerThreadId = pair?.worker?.threadId ?? null;
  const update = useCallback(async (maxButlerTurns: number | null) => {
    if (!workerThreadId) return;
    setPending(true);
    setError(null);
    try {
      const payload = await postJson<{ supervision: PairWorkerSupervision }>("/api/threads/supervision", {
        threadId: workerThreadId,
        maxButlerTurns
      });
      setPair((current) => current?.worker?.threadId === workerThreadId
        ? { ...current, workerSupervision: payload.supervision }
        : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }, [setError, setPair, workerThreadId]);
  return { pending, update };
}
