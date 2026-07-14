import { useCallback, useState } from "react";

import { deleteJson, patchJson } from "./api";
import type { PairAutomation, PairDetail } from "../shared/pairing";

export function useSessionAutomation(
  pair: PairDetail | null,
  onUpdated: (automation: PairAutomation | null) => void,
  onEdit: (automation: PairAutomation) => void
) {
  const [pending, setPending] = useState(false);
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!pair || pending) return;
    setPending(true);
    try {
      const payload = await patchJson<{ automation: PairAutomation }>(`/api/pairs/${encodeURIComponent(pair.id)}/automation`, { enabled });
      onUpdated(payload.automation);
    } finally { setPending(false); }
  }, [onUpdated, pair, pending]);
  const remove = useCallback(async () => {
    if (!pair || pending) return;
    setPending(true);
    try {
      await deleteJson(`/api/pairs/${encodeURIComponent(pair.id)}/automation`);
      onUpdated(null);
    } finally { setPending(false); }
  }, [onUpdated, pair, pending]);
  const edit = useCallback(() => { if (pair?.automation) onEdit(pair.automation); }, [onEdit, pair]);
  return { pending, setEnabled, remove, edit };
}
