import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

import {
  BUTLER_BACKGROUND_PROMPT_PREFIX,
  contentAttachmentSummary,
  contentToText,
  extractMessageTimestamp,
  isButlerBackgroundPromptText
} from "./butler-agent-helpers.js";
import { stripElapsedTaskTimeFooter } from "./task-timing.js";
import type {
  ProviderRuntimeContentStreamKind,
  ProviderRuntimeItemStatus,
  ProviderRuntimeItemType,
  ProviderRuntimeLivePatch,
  ProviderRuntimeThreadState,
  ProviderRuntimeTurnState
} from "../shared/provider-runtime.js";

const BUTLER_RUNTIME_THREAD_ID = "butler";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function messageRole(message: unknown): string | null {
  return isRecord(message) && typeof message.role === "string" ? message.role : null;
}

function hasTextContentSlot(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }

  const content = message.content;
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
    return type.includes("text") || typeof entry.text === "string";
  });
}

function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  const text = contentToText(message.content);
  if (text.trim()) {
    return stripElapsedTaskTimeFooter(text);
  }

  if (messageRole(message) === "user-with-attachments") {
    const attachmentSummary = contentAttachmentSummary(message.content);
    if (attachmentSummary.trim()) {
      return attachmentSummary;
    }
  }

  return typeof message.errorMessage === "string" ? message.errorMessage : "";
}

function messageAt(message: unknown, fallback: number): number {
  return isRecord(message) ? extractMessageTimestamp(message) ?? fallback : fallback;
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(summarizeValue).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return String(value);
  }

  const content = value.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : summarizeValue(entry))
      .filter(Boolean)
      .join("\n");
    if (text.trim()) {
      return text;
    }
  }

  for (const key of ["message", "text", "content", "summary", "description", "command", "cmd", "path", "url", "status"]) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return `${key}: ${entry}`;
    }
    if (entry && typeof entry === "object") {
      const nested = summarizeValue(entry);
      if (nested.trim()) {
        return `${key}: ${nested}`;
      }
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assistantTextDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): {
  streamKind: ProviderRuntimeContentStreamKind;
  delta: string;
  contentIndex?: number;
} | null {
  const assistantEvent = event.assistantMessageEvent;
  if (assistantEvent.type === "text_delta") {
    return {
      streamKind: "assistant_text",
      delta: assistantEvent.delta,
      contentIndex: assistantEvent.contentIndex
    };
  }
  if (assistantEvent.type === "thinking_delta") {
    return {
      streamKind: "reasoning_text",
      delta: assistantEvent.delta,
      contentIndex: assistantEvent.contentIndex
    };
  }
  return null;
}

function assistantContentText(
  event: Extract<AgentSessionEvent, { type: "message_update" }>,
  type: "thinking_end" | "text_end"
): string {
  const assistantEvent = event.assistantMessageEvent;
  return assistantEvent.type === type ? assistantEvent.content : "";
}

function turnState(message: AgentMessage): ProviderRuntimeTurnState {
  if (isRecord(message)) {
    if (message.stopReason === "aborted") return "interrupted";
    if (message.stopReason === "error") return "failed";
  }
  return "completed";
}

type LifecyclePatchInput = {
  threadId: string;
  turnId: string;
  itemId: string;
  itemType: ProviderRuntimeItemType;
  status: ProviderRuntimeItemStatus;
  text: string;
  at: number;
  title?: string;
};

export class PiProviderRuntimeMapper {
  private eventSequence = 0;
  private turnSequence = 0;
  private currentTurnId: string | null = null;
  private currentAssistantItemId: string | null = null;
  private currentUserItemId: string | null = null;
  private hideNextAssistantReply = false;

  constructor(private readonly threadId = BUTLER_RUNTIME_THREAD_ID) {}

  map(event: AgentSessionEvent, session: AgentSession): ProviderRuntimeLivePatch[] {
    const at = Date.now();

    switch (event.type) {
      case "agent_start":
        return [this.threadState("active", at)];
      case "agent_end":
        this.currentTurnId = null;
        this.currentAssistantItemId = null;
        this.currentUserItemId = null;
        return [this.threadState("idle", at)];
      case "turn_start": {
        const turnId = this.startTurn(session, at);
        return [{
          kind: "turn-lifecycle",
          threadId: this.threadId,
          turnId,
          status: "started",
          at
        }];
      }
      case "turn_end": {
        const turnId = this.ensureTurn(session, at);
        const state = turnState(event.message);
        this.currentTurnId = null;
        this.currentUserItemId = null;
        this.currentAssistantItemId = null;
        this.hideNextAssistantReply = false;
        return [{
          kind: "turn-lifecycle",
          threadId: this.threadId,
          turnId,
          status: state,
          at
        }];
      }
      case "message_start":
        return this.mapMessageStart(event, session, at);
      case "message_update":
        return this.mapMessageUpdate(event, session, at);
      case "message_end":
        return this.mapMessageEnd(event, session, at);
      case "tool_execution_start":
        return [this.itemLifecycle({
          threadId: this.threadId,
          turnId: this.ensureTurn(session, at),
          itemId: this.toolItemId(event.toolCallId),
          itemType: this.toolItemType(event.toolName),
          title: event.toolName,
          status: "in_progress",
          text: summarizeValue(event.args),
          at
        })];
      case "tool_execution_update":
        return [this.itemLifecycle({
          threadId: this.threadId,
          turnId: this.ensureTurn(session, at),
          itemId: this.toolItemId(event.toolCallId),
          itemType: this.toolItemType(event.toolName),
          title: event.toolName,
          status: "in_progress",
          text: summarizeValue(event.partialResult),
          at
        })];
      case "tool_execution_end":
        return [this.itemLifecycle({
          threadId: this.threadId,
          turnId: this.ensureTurn(session, at),
          itemId: this.toolItemId(event.toolCallId),
          itemType: this.toolItemType(event.toolName),
          title: event.toolName,
          status: event.isError ? "failed" : "completed",
          text: summarizeValue(event.result),
          at
        })];
      case "compaction_start": {
        const turnId = this.ensureTurn(session, at);
        return [this.itemLifecycle({
          threadId: this.threadId,
          turnId,
          itemId: `${turnId}:compaction`,
          itemType: "context_compaction",
          title: "Compaction",
          status: "in_progress",
          text: event.reason,
          at
        })];
      }
      case "compaction_end": {
        const turnId = this.ensureTurn(session, at);
        return [this.itemLifecycle({
          threadId: this.threadId,
          turnId,
          itemId: `${turnId}:compaction`,
          itemType: "context_compaction",
          title: "Compaction",
          status: event.errorMessage ? "failed" : "completed",
          text: event.errorMessage ?? event.reason,
          at
        })];
      }
      case "auto_retry_start":
        return [{
          kind: "runtime-message",
          threadId: this.threadId,
          tone: "warning",
          message: event.errorMessage,
          at
        }];
      case "auto_retry_end":
        return event.success ? [] : [{
          kind: "runtime-message",
          threadId: this.threadId,
          tone: "error",
          message: event.finalError ?? "Retry failed.",
          at
        }];
      default:
        return [];
    }
  }

  private startTurn(session: AgentSession, at: number): string {
    this.turnSequence += 1;
    this.currentTurnId = `butler-turn-${session.sessionId ?? "session"}-${this.turnSequence}-${at}`;
    return this.currentTurnId;
  }

  private ensureTurn(session: AgentSession, at: number): string {
    return this.currentTurnId ?? this.startTurn(session, at);
  }

  private messageItemId(session: AgentSession): string {
    return `message-${session.messages.length}`;
  }

  private toolItemId(toolCallId: string): string {
    return `${this.currentTurnId ?? "butler-turn"}:tool:${toolCallId}`;
  }

  private thinkingItemId(contentIndex: number | undefined): string {
    return `${this.currentTurnId ?? "butler-turn"}:thinking:${contentIndex ?? 0}`;
  }

  private toolItemType(toolName: string): ProviderRuntimeItemType {
    return toolName === "bash" || toolName === "execute_bash" ? "command_execution" : "dynamic_tool_call";
  }

  private threadState(state: ProviderRuntimeThreadState, at: number): ProviderRuntimeLivePatch {
    return {
      kind: "thread-state",
      threadId: this.threadId,
      state,
      at
    };
  }

  private itemLifecycle(input: LifecyclePatchInput): ProviderRuntimeLivePatch {
    return {
      kind: "item-lifecycle",
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      itemType: input.itemType,
      status: input.status,
      text: input.text,
      at: input.at,
      ...(input.title ? { title: input.title } : {})
    };
  }

  private mapMessageStart(
    event: Extract<AgentSessionEvent, { type: "message_start" }>,
    session: AgentSession,
    at: number
  ): ProviderRuntimeLivePatch[] {
    const role = messageRole(event.message);
    const text = messageText(event.message);

    if ((role === "user" || role === "user-with-attachments") && isButlerBackgroundPromptText(text)) {
      this.hideNextAssistantReply = true;
      return [];
    }

    if (role === "user" || role === "user-with-attachments") {
      this.currentUserItemId = this.messageItemId(session);
      return [];
    }

    if (role === "assistant") {
      if (this.hideNextAssistantReply) {
        return [];
      }
      if (!text.trim() && !hasTextContentSlot(event.message)) {
        return [];
      }
      const turnId = this.ensureTurn(session, at);
      this.currentAssistantItemId = this.messageItemId(session);
      return [this.itemLifecycle({
        threadId: this.threadId,
        turnId,
        itemId: this.currentAssistantItemId,
        itemType: "assistant_message",
        status: "in_progress",
        text: "",
        at: messageAt(event.message, at),
        title: "Assistant message"
      })];
    }

    return [];
  }

  private mapMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
    session: AgentSession,
    at: number
  ): ProviderRuntimeLivePatch[] {
    if (this.hideNextAssistantReply) {
      return [];
    }

    const turnId = this.ensureTurn(session, at);
    const assistantEvent = event.assistantMessageEvent;
    const delta = assistantTextDelta(event);
    if (delta) {
      const itemId = delta.streamKind === "assistant_text"
        ? this.currentAssistantItemId ?? this.messageItemId(session)
        : this.thinkingItemId(delta.contentIndex);
      if (delta.streamKind === "assistant_text") {
        this.currentAssistantItemId = itemId;
      }
      return [{
        kind: "content-delta",
        threadId: this.threadId,
        turnId,
        itemId,
        itemType: delta.streamKind === "assistant_text" ? "assistant_message" : "reasoning",
        streamKind: delta.streamKind,
        delta: delta.delta,
        itemTextLength: this.readPatchTextLength(event, delta.streamKind, delta.contentIndex, delta.delta),
        at
      }];
    }

    if (assistantEvent.type === "thinking_start") {
      return [this.itemLifecycle({
        threadId: this.threadId,
        turnId,
        itemId: this.thinkingItemId(assistantEvent.contentIndex),
        itemType: "reasoning",
        status: "in_progress",
        text: "",
        at,
        title: "Thinking"
      })];
    }

    if (assistantEvent.type === "thinking_end") {
      return [this.itemLifecycle({
        threadId: this.threadId,
        turnId,
        itemId: this.thinkingItemId(assistantEvent.contentIndex),
        itemType: "reasoning",
        status: "completed",
        text: assistantContentText(event, "thinking_end"),
        at,
        title: "Thinking"
      })];
    }

    if (assistantEvent.type === "text_end") {
      const itemId = this.currentAssistantItemId ?? this.messageItemId(session);
      this.currentAssistantItemId = itemId;
      return [this.itemLifecycle({
        threadId: this.threadId,
        turnId,
        itemId,
        itemType: "assistant_message",
        status: "in_progress",
        text: stripElapsedTaskTimeFooter(assistantContentText(event, "text_end")),
        at,
        title: "Assistant message"
      })];
    }

    return [];
  }

  private mapMessageEnd(
    event: Extract<AgentSessionEvent, { type: "message_end" }>,
    session: AgentSession,
    at: number
  ): ProviderRuntimeLivePatch[] {
    const role = messageRole(event.message);
    const text = messageText(event.message);

    if ((role === "user" || role === "user-with-attachments") && text.trimStart().startsWith(BUTLER_BACKGROUND_PROMPT_PREFIX)) {
      return [];
    }

    if (role === "assistant" && this.hideNextAssistantReply) {
      if (text.trim()) {
        this.hideNextAssistantReply = false;
      }
      this.currentAssistantItemId = null;
      return [];
    }

    if (role === "assistant" && !text.trim() && !hasTextContentSlot(event.message)) {
      this.currentAssistantItemId = null;
      return [];
    }

    if (role === "user" || role === "user-with-attachments") {
      if (!text.trim()) {
        this.currentUserItemId = null;
        return [];
      }
      const itemId = this.currentUserItemId ?? this.messageItemId(session);
      this.currentUserItemId = null;
      return [this.itemLifecycle({
        threadId: this.threadId,
        turnId: this.ensureTurn(session, at),
        itemId,
        itemType: "user_message",
        status: "completed",
        text,
        at: messageAt(event.message, at),
        title: "User message"
      })];
    }

    if (role !== "assistant") {
      return [];
    }

    const itemId = this.currentAssistantItemId ?? this.messageItemId(session);
    this.currentAssistantItemId = null;
    return [this.itemLifecycle({
      threadId: this.threadId,
      turnId: this.ensureTurn(session, at),
      itemId,
      itemType: "assistant_message",
      status: isRecord(event.message) && event.message.stopReason === "error" ? "failed" : "completed",
      text,
      at: messageAt(event.message, at),
      title: "Assistant message"
    })];
  }

  private readPatchTextLength(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
    streamKind: ProviderRuntimeContentStreamKind,
    contentIndex: number | undefined,
    fallbackDelta: string
  ): number {
    const assistantEvent = event.assistantMessageEvent;
    const partial = "partial" in assistantEvent ? assistantEvent.partial : null;
    const content = isRecord(partial) && Array.isArray(partial.content) ? partial.content : [];
    const block = typeof contentIndex === "number" ? content[contentIndex] : null;
    if (isRecord(block)) {
      if (streamKind === "assistant_text" && typeof block.text === "string") {
        return stripElapsedTaskTimeFooter(block.text).length;
      }
      if (streamKind === "reasoning_text" && typeof block.thinking === "string") {
        return block.thinking.length;
      }
    }
    return fallbackDelta.length;
  }
}
