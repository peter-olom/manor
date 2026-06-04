import { useEffect, useRef } from "react";

import type { ReasoningEffort, ShellSnapshot } from "./types";

export function appendComposerText(current: string, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return current;
  }

  const trimmedCurrent = current.trim();
  return trimmedCurrent ? `${trimmedCurrent}\n\n${trimmedAddition}` : trimmedAddition;
}

export function useDelegatedThreadEffortSync({
  requestedEffort,
  shell,
  threadId,
  updateCodexCompose
}: {
  requestedEffort: ReasoningEffort | null | undefined;
  shell: ShellSnapshot | null | undefined;
  threadId: string | null | undefined;
  updateCodexCompose: (model: string, effort: ReasoningEffort | null) => Promise<void>;
}) {
  const syncedThreadEffortsRef = useRef<Record<string, ReasoningEffort>>({});

  useEffect(() => {
    const modelId = shell?.codex.compose.model;
    if (!threadId || !requestedEffort || !modelId || syncedThreadEffortsRef.current[threadId] === requestedEffort) {
      return;
    }

    const model = shell.codex.compose.availableModels.find((entry) => entry.id === modelId);
    if (model && model.supportedReasoningEfforts.length > 0 && !model.supportedReasoningEfforts.includes(requestedEffort)) {
      return;
    }

    syncedThreadEffortsRef.current[threadId] = requestedEffort;
    if (shell.codex.compose.effort !== requestedEffort) {
      void updateCodexCompose(modelId, requestedEffort);
    }
  }, [requestedEffort, shell?.codex.compose.availableModels, shell?.codex.compose.effort, shell?.codex.compose.model, threadId, updateCodexCompose]);
}
