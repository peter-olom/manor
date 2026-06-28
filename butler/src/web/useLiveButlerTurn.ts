import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type { PairTraceItem, PairTraceItemStatus, PairTraceItemType } from "../shared/pairing";

export type LiveTurnState = {
  turnId: string | null;
  items: Map<string, PairTraceItem>;
  assistantItemId: string | null;
  assistantText: string;
  status: "idle" | "streaming" | "completed" | "failed" | "interrupted" | "cancelled";
  startedAt: number | null;
  completedAt: number | null;
};

export type CompletedTrace = {
  messageId: string;
  items: PairTraceItem[];
  durationMs: number;
  startedAt: number;
  completedAt: number;
};

const INITIAL: LiveTurnState = {
  turnId: null,
  items: new Map(),
  assistantItemId: null,
  assistantText: "",
  status: "idle",
  startedAt: null,
  completedAt: null
};

function toTraceItemType(value: string): PairTraceItemType {
  const allowed: PairTraceItemType[] = [
    "reasoning",
    "command_execution",
    "file_change",
    "plan",
    "mcp_tool_call",
    "dynamic_tool_call",
    "web_search",
    "image_view",
    "context_compaction",
    "user_message",
    "assistant_message",
    "error",
    "unknown"
  ];
  return (allowed as string[]).includes(value) ? (value as PairTraceItemType) : "unknown";
}

function toStatus(value: string): PairTraceItemStatus {
  if (value === "completed" || value === "failed" || value === "declined" || value === "in_progress") {
    return value;
  }
  return "in_progress";
}

export type UseLiveButlerTurnResult = {
  state: LiveTurnState;
  completedTraces: CompletedTrace[];
  reset: () => void;
  applyPatch: (patch: ProviderRuntimeLivePatch) => void;
};

export function useLiveButlerTurn(threadId: string): UseLiveButlerTurnResult {
  const [state, setState] = useState<LiveTurnState>(INITIAL);
  const [completedTraces, setCompletedTraces] = useState<CompletedTrace[]>([]);
  const lastThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (lastThreadIdRef.current !== threadId) {
      lastThreadIdRef.current = threadId;
      setState(INITIAL);
      setCompletedTraces([]);
    }
  }, [threadId]);

  const applyPatch = useCallback((patch: ProviderRuntimeLivePatch) => {
    if (!patch || typeof patch !== "object" || typeof patch.kind !== "string") return;
    setState((current) => applyPatchToState(current, patch, setCompletedTraces));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
    setCompletedTraces([]);
  }, []);

  return { state, completedTraces, reset, applyPatch };
}

function applyPatchToState(
  current: LiveTurnState,
  patch: ProviderRuntimeLivePatch,
  setCompletedTraces: React.Dispatch<React.SetStateAction<CompletedTrace[]>>
): LiveTurnState {
  switch (patch.kind) {
    case "turn-lifecycle": {
      if (patch.status === "started") {
        return {
          turnId: patch.turnId,
          items: new Map(),
          assistantItemId: null,
          assistantText: "",
          status: "streaming",
          startedAt: patch.at,
          completedAt: null
        };
      }
      if (current.turnId !== patch.turnId) return current;
      const finalItems = [...current.items.values()].sort((a, b) => a.at - b.at);
      if (finalItems.length > 0 && current.startedAt !== null) {
        const startedAt = current.startedAt;
        const completedAt = patch.at;
        setCompletedTraces((traces) => {
          const assistantItemId = current.assistantItemId;
          const items = assistantItemId
            ? finalItems.filter((item) => item.id !== assistantItemId)
            : finalItems;
          if (items.length === 0) return traces;
          const next: CompletedTrace = {
            messageId: assistantItemId ?? `trace-${patch.turnId}-${completedAt}`,
            items,
            durationMs: Math.max(0, completedAt - startedAt),
            startedAt,
            completedAt
          };
          return [...traces.slice(-9), next];
        });
      }
      const status: LiveTurnState["status"] =
        patch.status === "failed" || patch.status === "interrupted" || patch.status === "cancelled"
          ? patch.status
          : "completed";
      return {
        ...current,
        status,
        completedAt: patch.at
      };
    }
    case "item-lifecycle": {
      if (!patch.turnId || !patch.itemId) return current;
      if (current.turnId === null) {
        return {
          ...current,
          turnId: patch.turnId,
          items: new Map(),
          assistantItemId: null,
          assistantText: "",
          status: "streaming",
          startedAt: patch.at,
          completedAt: null
        };
      }
      if (patch.turnId !== current.turnId) return current;
      if (patch.itemType === "assistant_message") {
        return {
          ...current,
          assistantItemId: patch.itemId,
          assistantText: patch.text || current.assistantText
        };
      }
      const next = new Map(current.items);
      const existing = next.get(patch.itemId);
      next.set(patch.itemId, {
        id: patch.itemId,
        type: toTraceItemType(patch.itemType),
        status: toStatus(patch.status),
        text: patch.text,
        title: patch.title,
        at: existing?.at ?? patch.at,
        completedAt: patch.status === "completed" ? patch.at : null
      });
      return { ...current, items: next };
    }
    case "content-delta": {
      if (!patch.turnId || !patch.itemId) return current;
      if (current.turnId === null) {
        return {
          ...current,
          turnId: patch.turnId,
          items: new Map(),
          assistantItemId: patch.itemType === "assistant_message" ? patch.itemId : null,
          assistantText: patch.itemType === "assistant_message" ? patch.delta : "",
          status: "streaming",
          startedAt: patch.at,
          completedAt: null
        };
      }
      if (patch.turnId !== current.turnId) return current;
      if (patch.itemType === "assistant_message" || patch.streamKind === "assistant_text") {
        return {
          ...current,
          assistantItemId: patch.itemId,
          assistantText: current.assistantText + patch.delta
        };
      }
      const next = new Map(current.items);
      const existing = next.get(patch.itemId);
      const type = toTraceItemType(patch.itemType);
      next.set(patch.itemId, {
        id: patch.itemId,
        type,
        status: existing?.status ?? "in_progress",
        text: (existing?.text ?? "") + patch.delta,
        title: existing?.title,
        at: existing?.at ?? patch.at,
        completedAt: existing?.completedAt ?? null
      });
      return { ...current, items: next };
    }
    default:
      return current;
  }
}
