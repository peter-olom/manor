import { useCallback, useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { ManorRestartDialog } from "./ManorRestartDialog";
import { reconcileClearedManorRestartRequest, type ClearedManorRestartRequest } from "./pair-selection";
import type { PairDetail } from "../shared/pairing";

export function useManorRestartApproval(
  pair: PairDetail | null,
  setPair: Dispatch<SetStateAction<PairDetail | null>>
): { reconcilePair: (pair: PairDetail) => PairDetail; dialog: ReactNode } {
  const clearedRef = useRef<ClearedManorRestartRequest | null>(null);
  const reconcilePair = useCallback((nextPair: PairDetail): PairDetail => {
    const reconciled = reconcileClearedManorRestartRequest(nextPair, clearedRef.current);
    clearedRef.current = reconciled.cleared;
    return reconciled.pair;
  }, []);
  const request = pair?.pendingManorRestartRequest ?? null;
  const dialog = pair && request ? (
    <ManorRestartDialog
      key={request.id}
      pairId={pair.id}
      request={request}
      onCleared={() => {
        clearedRef.current = { pairId: pair.id, requestId: request.id };
        setPair((current) => current?.id === pair.id
          ? { ...current, pendingManorRestartRequest: null }
          : current);
      }}
    />
  ) : null;
  return { reconcilePair, dialog };
}
