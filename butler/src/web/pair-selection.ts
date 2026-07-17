export type PairSelectionOption = {
  id: string;
};

export function reconcileSelectedPairId(
  selectedPairId: string | null,
  pairs: readonly PairSelectionOption[]
): string | null {
  if (selectedPairId && pairs.some((pair) => pair.id === selectedPairId)) {
    return selectedPairId;
  }
  return pairs[0]?.id ?? null;
}

export function shouldReportPairDetailError(
  requestedPairId: string,
  selectedPairId: string | null,
  suppressedPairIds: ReadonlySet<string>
): boolean {
  return requestedPairId === selectedPairId && !suppressedPairIds.has(requestedPairId);
}

export function shouldReconcilePairDetail(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}

export function shouldClearDeletedPairSelection(
  deletedPairId: string,
  selectedPairId: string | null
): boolean {
  return deletedPairId === selectedPairId;
}

export function canBeginPairDeletion(
  pairId: string,
  deletingPairIds: ReadonlySet<string>
): boolean {
  return !deletingPairIds.has(pairId);
}
