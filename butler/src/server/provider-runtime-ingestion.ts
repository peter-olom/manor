import { EventEmitter } from "node:events";

import type { ButlerStateStore } from "./state-store.js";
import type {
  ProviderRuntimeContentStreamKind,
  ProviderRuntimeEvent,
  ProviderRuntimeItemStatus,
  ProviderRuntimeItemType,
  ProviderRuntimeLivePatch
} from "../shared/provider-runtime.js";
import { redactLiveReasoningPreview, redactLiveReasoningText, redactSensitiveText } from "./redact-sensitive-text.js";

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
  return { type: state === "active" ? "active" : "idle" };
}

function providerErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return redactSensitiveText(detail.trim()).slice(0, 3000);
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return redactSensitiveText(value.trim()).slice(0, 3000);
      if (value && typeof value === "object") {
        const nested = providerErrorDetail(value, "");
        if (nested) return nested;
      }
    }
  }
  return fallback;
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
  private readonly contentStreams = new Map<string, {
    raw: string;
    emitted: string;
    threadId: string;
    turnId: string;
    itemId: string;
    itemType: ProviderRuntimeItemType;
    streamKind: ProviderRuntimeContentStreamKind;
    at: number;
  }>();

  constructor(private readonly store: ButlerStateStore) {
    super();
  }

  ingest(event: ProviderRuntimeEvent, shouldApply: () => boolean = () => true): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(() => shouldApply() ? this.apply(event) : undefined);
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
        if (event.payload.state !== "active") {
          this.flushThreadStreams(event.threadId, event.at);
        }
        this.store.upsertThreadSummary({
          id: event.threadId,
          status: storeThreadStatus(event.payload.state),
          source: "appServer"
        });
        if (event.payload.state === "error") {
          const detail = providerErrorDetail(event.payload.detail, "Codex thread entered a system error state.");
          const turnId = this.terminalizeLatestTurn(event.threadId, "failed", detail, event.at);
          this.recordRuntimeMessage(event.threadId, "error", detail, event.at, turnId);
        }
        this.store.setThreadStatus(event.threadId, storeThreadStatus(event.payload.state));
        this.emit("runtimePatch", {
          kind: "thread-state",
          threadId: event.threadId,
          state: event.payload.state,
          at: event.at
        });
        if (event.payload.state !== "active") await this.store.flushSave();
        return;
      case "session.state.changed":
        if (event.payload.state === "stopped" || event.payload.state === "error") {
          this.flushThreadStreams(event.threadId, event.at);
          await this.store.flushSave();
        }
        return;
      case "session.exited":
        this.flushThreadStreams(event.threadId, event.at);
        {
          const detail = providerErrorDetail(event.payload.reason, "Codex provider session exited before the turn completed.");
          const turnId = this.terminalizeLatestTurn(event.threadId, "interrupted", detail, event.at);
          if (turnId) this.recordRuntimeMessage(event.threadId, "error", detail, event.at, turnId);
          this.store.setThreadStatus(event.threadId, { type: "idle" });
          this.emit("runtimePatch", { kind: "thread-state", threadId: event.threadId, state: "idle", at: event.at });
          await this.store.flushSave();
        }
        return;
      case "thread.metadata.updated":
        this.store.upsertThreadSummary({
          id: event.threadId,
          ...(event.payload.name ? { name: event.payload.name } : {})
        });
        return;
      case "thread.settings.updated": {
        const effort = typeof event.payload.effort === "string" ? event.payload.effort : null;
        if (effort) {
          this.store.setThreadRequestedReasoningEffort(event.threadId, effort as never);
        }
        return;
      }
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
        this.flushTurnStreams(event.threadId, event.turnId, event.at);
        const turnError = event.payload.errorMessage ? redactSensitiveText(event.payload.errorMessage).slice(0, 3000) : null;
        this.store.updateTurn(event.threadId, {
          id: event.turnId,
          status: event.payload.state,
          error: turnError
        });
        this.emit("runtimePatch", {
          kind: "turn-lifecycle",
          threadId: event.threadId,
          turnId: event.turnId,
          status: event.payload.state,
          at: event.at
        });
        await this.store.flushSave();
        return;
      case "turn.aborted":
        if (!event.turnId) return;
        this.flushTurnStreams(event.threadId, event.turnId, event.at);
        {
          const detail = providerErrorDetail(event.payload.reason, "Codex turn was aborted.");
          this.store.updateTurn(event.threadId, { id: event.turnId, status: "interrupted", error: detail });
          this.emit("runtimePatch", {
            kind: "turn-lifecycle",
            threadId: event.threadId,
            turnId: event.turnId,
            status: "interrupted",
            at: event.at
          });
          await this.store.flushSave();
        }
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
        if (event.type === "runtime.error") {
          if (event.turnId) this.flushTurnStreams(event.threadId, event.turnId, event.at);
          else this.flushThreadStreams(event.threadId, event.at);
        }
        this.recordRuntimeMessage(
          event.threadId,
          event.type === "runtime.error" ? "error" : "warning",
          event.payload.message,
          event.at,
          event.turnId
        );
        if (event.type === "runtime.error") await this.store.flushSave();
        return;
      case "request.opened":
        this.recordRuntimeMessage(
          event.threadId,
          "error",
          `Direct Worker provider request is unsupported (${event.payload.requestType})${event.payload.detail ? `: ${event.payload.detail}` : "."}`,
          event.at,
          event.turnId
        );
        await this.store.flushSave();
        return;
      case "userInput.requested":
        this.recordRuntimeMessage(
          event.threadId,
          "error",
          "Direct Worker requested operator input through an unsupported provider prompt. Ask the operator through Butler instead.",
          event.at,
          event.turnId
        );
        await this.store.flushSave();
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

    if (event.type === "item.completed") {
      this.flushItemStream(event.threadId, event.turnId, event.itemId, event.at);
    }

    const itemStatus = lifecycleStatus(
      event.payload.status,
      event.type === "item.completed" ? "completed" : "in_progress"
    );
    const persistedStatus = itemStatus === "in_progress" ? "started" : itemStatus;
    const text = redactSensitiveText(eventText(event));
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
      persistedStatus
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
    const key = this.contentStreamKey(event.threadId, event.turnId, event.itemId);
    const current = this.contentStreams.get(key) ?? {
      raw: "",
      emitted: "",
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      itemType,
      streamKind: event.payload.streamKind,
      at: event.at
    };
    const raw = current.raw + event.payload.delta;
    const preview = redactLiveReasoningPreview(raw);
    const safeDelta = preview.startsWith(current.emitted) ? preview.slice(current.emitted.length) : "";
    this.contentStreams.set(key, { ...current, raw, emitted: safeDelta ? preview : current.emitted, at: event.at });
    if (!safeDelta) return;
    this.store.appendItemDelta(
      event.threadId,
      event.turnId,
      event.itemId,
      safeDelta,
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
      delta: safeDelta,
      itemTextLength: item?.text.length ?? safeDelta.length,
      at: event.at
    });
  }

  private contentStreamKey(threadId: string, turnId: string, itemId: string): string {
    return `${threadId}\u0000${turnId}\u0000${itemId}`;
  }

  private flushItemStream(threadId: string, turnId: string, itemId: string, at: number): void {
    const key = this.contentStreamKey(threadId, turnId, itemId);
    const stream = this.contentStreams.get(key);
    if (!stream) return;
    this.contentStreams.delete(key);
    const finalText = redactLiveReasoningText(stream.raw);
    if (!finalText.startsWith(stream.emitted)) return;
    const delta = finalText.slice(stream.emitted.length);
    if (!delta) return;
    this.store.appendItemDelta(threadId, turnId, itemId, delta, storeItemType(stream.itemType, stream.streamKind), { emitChange: false });
    const item = this.store.getThread(threadId)?.turns.find((turn) => turn.id === turnId)?.items.find((entry) => entry.id === itemId);
    this.emit("runtimePatch", {
      kind: "content-delta",
      threadId,
      turnId,
      itemId,
      itemType: stream.itemType,
      streamKind: stream.streamKind,
      delta,
      itemTextLength: item?.text.length ?? finalText.length,
      at
    });
  }

  private flushTurnStreams(threadId: string, turnId: string, at: number): void {
    for (const stream of [...this.contentStreams.values()]) {
      if (stream.threadId === threadId && stream.turnId === turnId) {
        this.flushItemStream(threadId, turnId, stream.itemId, at);
      }
    }
  }

  private flushThreadStreams(threadId: string, at: number): void {
    for (const stream of [...this.contentStreams.values()]) {
      if (stream.threadId === threadId) {
        this.flushItemStream(threadId, stream.turnId, stream.itemId, at);
      }
    }
  }

  private terminalizeLatestTurn(
    threadId: string,
    status: "failed" | "interrupted",
    detail: string,
    at: number
  ): string | undefined {
    const turn = [...(this.store.getThread(threadId)?.turns ?? [])].reverse().find((entry) =>
      !["completed", "failed", "interrupted", "cancelled"].includes(entry.status));
    if (!turn) return undefined;
    this.store.updateTurn(threadId, { id: turn.id, status, error: detail });
    this.emit("runtimePatch", { kind: "turn-lifecycle", threadId, turnId: turn.id, status, at });
    return turn.id;
  }

  private recordRuntimeMessage(
    threadId: string,
    tone: "warning" | "error",
    message: string,
    at: number,
    turnId?: string
  ): void {
    const detail = redactSensitiveText(message).slice(0, 3000);
    this.store.addEvent(threadId, tone === "error" ? "runtime.error" : "runtime.warning", detail);
    this.emit("runtimePatch", { kind: "runtime-message", threadId, ...(turnId ? { turnId } : {}), tone, message: detail, at });
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
