import { EventEmitter } from "node:events";

import type { ButlerStateStore } from "./state-store.js";
import type {
  ProviderRuntimeContentStreamKind,
  ProviderRuntimeEvent,
  ProviderRuntimeItemStatus,
  ProviderRuntimeItemType,
  ProviderRuntimeLivePatch
} from "../shared/provider-runtime.js";

type ProviderRuntimeIngestionEvents = {
  runtimePatch: [ProviderRuntimeLivePatch];
};

function storeItemType(itemType: ProviderRuntimeItemType, streamKind?: ProviderRuntimeContentStreamKind): string {
  if (streamKind === "assistant_text") return "agentMessage";
  if (streamKind === "command_output") return "commandExecution";
  if (streamKind === "file_change_output") return "fileChange";
  if (streamKind === "reasoning_text" || streamKind === "reasoning_summary_text") return "reasoning";
  if (streamKind === "plan_text") return "plan";

  switch (itemType) {
    case "assistant_message":
      return "agentMessage";
    case "user_message":
      return "userMessage";
    case "command_execution":
      return "commandExecution";
    case "file_change":
      return "fileChange";
    case "web_search":
      return "webSearch";
    case "context_compaction":
      return "contextCompaction";
    default:
      return itemType;
  }
}

function storeTurnStatus(): string {
  return "in_progress";
}

function storeThreadStatus(state: string): { type: "active" | "idle" } {
  return { type: state === "idle" ? "idle" : "active" };
}

function eventText(event: Extract<ProviderRuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }>): string {
  if (event.payload.itemType === "user_message" || event.payload.itemType === "assistant_message") {
    return event.payload.detail ?? "";
  }

  return event.payload.detail ?? event.payload.title ?? "";
}

function lifecycleStatus(status: ProviderRuntimeItemStatus | undefined, fallback: ProviderRuntimeItemStatus): ProviderRuntimeItemStatus {
  return status ?? fallback;
}

function threadSummaryPayload(event: Extract<ProviderRuntimeEvent, { type: "thread.started" }>): Record<string, unknown> {
  const rawPayload = event.raw?.payload;
  const rawThread = rawPayload && typeof rawPayload === "object" && "thread" in rawPayload
    ? (rawPayload as { thread?: unknown }).thread
    : null;
  if (rawThread && typeof rawThread === "object") {
    return rawThread as Record<string, unknown>;
  }

  return {
    id: event.threadId,
    status: { type: "active" },
    source: "appServer"
  };
}

export class ProviderRuntimeIngestion extends EventEmitter<ProviderRuntimeIngestionEvents> {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: ButlerStateStore) {
    super();
  }

  ingest(event: ProviderRuntimeEvent): Promise<void> {
    this.queue = this.queue.then(() => this.apply(event));
    return this.queue;
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private async apply(event: ProviderRuntimeEvent): Promise<void> {
    switch (event.type) {
      case "thread.started":
        this.store.upsertThreadSummary(threadSummaryPayload(event));
        return;
      case "thread.state.changed":
        this.store.upsertThreadSummary({
          id: event.threadId,
          status: storeThreadStatus(event.payload.state),
          source: "appServer"
        });
        this.store.setThreadStatus(event.threadId, storeThreadStatus(event.payload.state));
        this.emit("runtimePatch", {
          kind: "thread-state",
          threadId: event.threadId,
          state: event.payload.state,
          at: event.at
        });
        return;
      case "thread.metadata.updated":
        this.store.upsertThreadSummary({
          id: event.threadId,
          ...(event.payload.name ? { name: event.payload.name } : {})
        });
        return;
      case "thread.tokenUsage.updated":
        this.store.updateThreadTokenUsage(event.threadId, {
          totalTokens: event.payload.tokens,
          modelContextWindow: event.payload.contextWindow
        });
        this.emit("runtimePatch", {
          kind: "token-usage",
          threadId: event.threadId,
          tokens: event.payload.tokens,
          contextWindow: event.payload.contextWindow,
          percent: event.payload.percent,
          at: event.at
        });
        return;
      case "turn.started":
        if (!event.turnId) {
          return;
        }
        this.store.updateTurn(event.threadId, {
          id: event.turnId,
          status: storeTurnStatus(),
          requestedReasoningEffort: event.payload.effort
        });
        this.emit("runtimePatch", {
          kind: "turn-lifecycle",
          threadId: event.threadId,
          turnId: event.turnId,
          status: "started",
          at: event.at
        });
        return;
      case "turn.completed":
        if (!event.turnId) {
          return;
        }
        this.store.updateTurn(event.threadId, {
          id: event.turnId,
          status: event.payload.state,
          error: event.payload.errorMessage ?? null
        });
        this.emit("runtimePatch", {
          kind: "turn-lifecycle",
          threadId: event.threadId,
          turnId: event.turnId,
          status: event.payload.state,
          at: event.at
        });
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.applyItemLifecycle(event);
        return;
      case "content.delta":
        this.applyContentDelta(event);
        return;
      case "runtime.warning":
      case "runtime.error":
        this.store.addEvent(event.threadId, event.type, event.payload.message);
        this.emit("runtimePatch", {
          kind: "runtime-message",
          threadId: event.threadId,
          tone: event.type === "runtime.error" ? "error" : "warning",
          message: event.payload.message,
          at: event.at
        });
        return;
      default:
        return;
    }
  }

  private applyItemLifecycle(
    event: Extract<ProviderRuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }>
  ): void {
    if (!event.turnId || !event.itemId) {
      return;
    }

    const status = event.type === "item.completed" ? "completed" : "started";
    const itemStatus = lifecycleStatus(event.payload.status, status === "completed" ? "completed" : "in_progress");
    const text = eventText(event);
    this.store.updateItem(
      event.threadId,
      event.turnId,
      {
        id: event.itemId,
        type: storeItemType(event.payload.itemType),
        text,
        command: text,
        status: itemStatus
      },
      status
    );
    this.emit("runtimePatch", {
      kind: "item-lifecycle",
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      itemType: event.payload.itemType,
      status: itemStatus,
      ...(event.payload.title ? { title: event.payload.title } : {}),
      text,
      at: event.at
    });
  }

  private applyContentDelta(event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>): void {
    if (!event.turnId || !event.itemId) {
      return;
    }

    const itemType = itemTypeFromStream(event.payload.streamKind);
    this.store.appendItemDelta(
      event.threadId,
      event.turnId,
      event.itemId,
      event.payload.delta,
      storeItemType(itemType, event.payload.streamKind),
      { emitChange: false }
    );
    const item = this.store.getThread(event.threadId)?.turns
      .find((turn) => turn.id === event.turnId)
      ?.items.find((entry) => entry.id === event.itemId);

    this.emit("runtimePatch", {
      kind: "content-delta",
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      itemType,
      streamKind: event.payload.streamKind,
      delta: event.payload.delta,
      itemTextLength: item?.text.length ?? event.payload.delta.length,
      at: event.at
    });
  }
}

function itemTypeFromStream(streamKind: ProviderRuntimeContentStreamKind): ProviderRuntimeItemType {
  switch (streamKind) {
    case "assistant_text":
      return "assistant_message";
    case "command_output":
      return "command_execution";
    case "file_change_output":
      return "file_change";
    case "reasoning_text":
    case "reasoning_summary_text":
      return "reasoning";
    case "plan_text":
      return "plan";
    default:
      return "unknown";
  }
}
