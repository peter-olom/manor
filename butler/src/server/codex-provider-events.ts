import crypto from "node:crypto";

import type {
  ProviderRuntimeContentStreamKind,
  ProviderRuntimeEvent,
  ProviderRuntimeItemStatus,
  ProviderRuntimeItemType,
  ProviderRuntimeRefs,
  ProviderRuntimeRequestType,
  ProviderRuntimeThreadState,
  ProviderRuntimeTurnState
} from "../shared/provider-runtime.js";

export type CodexProviderEventInput = {
  method: string;
  params?: Record<string, unknown>;
  at?: number;
  eventId?: string;
  providerInstanceId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function eventThreadId(params: Record<string, unknown>): string | undefined {
  return asString(params.threadId) ?? asString(asRecord(params.thread)?.id);
}

function eventTurnId(params: Record<string, unknown>): string | undefined {
  return asString(params.turnId) ?? asString(asRecord(params.turn)?.id);
}

function eventItemId(params: Record<string, unknown>): string | undefined {
  return asString(params.itemId) ?? asString(asRecord(params.item)?.id);
}

function eventRequestId(params: Record<string, unknown>): string | undefined {
  return asString(params.requestId) ?? asString(params.id);
}

function baseEvent(
  input: CodexProviderEventInput,
  params: Record<string, unknown>,
  threadId: string
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs: ProviderRuntimeRefs = {};
  const turnId = eventTurnId(params);
  const itemId = eventItemId(params);
  const requestId = eventRequestId(params);

  refs.providerThreadId = threadId;
  if (turnId) refs.providerTurnId = turnId;
  if (itemId) refs.providerItemId = itemId;
  if (requestId) refs.providerRequestId = requestId;

  return {
    id: input.eventId ?? crypto.randomUUID(),
    harness: "codex",
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    threadId,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(requestId ? { requestId } : {}),
    at: input.at ?? Date.now(),
    providerRefs: refs,
    raw: {
      source: "codex.app-server",
      method: input.method,
      payload: params
    }
  };
}

function decodeDelta(params: Record<string, unknown>): string | null {
  if (typeof params.delta === "string") {
    return params.delta;
  }
  if (typeof params.textDelta === "string") {
    return params.textDelta;
  }
  if (typeof params.deltaBase64 !== "string") {
    return null;
  }
  try {
    return Buffer.from(params.deltaBase64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function normalizeItemType(raw: unknown): ProviderRuntimeItemType {
  const value = typeof raw === "string" ? raw : "";
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return "unknown";
  if (normalized.includes("user")) return "user_message";
  if (normalized.includes("agent message") || normalized.includes("assistant")) return "assistant_message";
  if (normalized.includes("reasoning") || normalized.includes("thought")) return "reasoning";
  if (normalized.includes("plan") || normalized.includes("todo")) return "plan";
  if (normalized.includes("command")) return "command_execution";
  if (normalized.includes("file change") || normalized.includes("patch") || normalized.includes("edit")) return "file_change";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("dynamic tool")) return "dynamic_tool_call";
  if (normalized.includes("collab")) return "collab_agent_tool_call";
  if (normalized.includes("web search")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  if (normalized.includes("compact")) return "context_compaction";
  if (normalized.includes("error")) return "error";
  return "unknown";
}

function itemTitle(type: ProviderRuntimeItemType): string | undefined {
  switch (type) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool";
    case "dynamic_tool_call":
      return "Tool";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image";
    case "context_compaction":
      return "Context compaction";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return trimText(value);
  }
  const record = asRecord(value);
  if (record && typeof record.text === "string") {
    return trimText(record.text);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  return trimText(
    value
      .map((entry) => {
        const record = asRecord(entry);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n")
  );
}

function messageItemDetail(item: Record<string, unknown>): string | undefined {
  return (
    trimText(item.text) ??
    trimText(item.prompt) ??
    contentText(item.content) ??
    trimText(item.summary)
  );
}

function itemDetail(item: Record<string, unknown>, itemType: ProviderRuntimeItemType): string | undefined {
  if (itemType === "user_message" || itemType === "assistant_message") {
    return messageItemDetail(item);
  }

  return (
    trimText(item.command) ??
    trimText(item.title) ??
    trimText(item.summary) ??
    trimText(item.text) ??
    trimText(item.path) ??
    trimText(item.prompt)
  );
}

function threadState(status: unknown, method: string): ProviderRuntimeThreadState {
  if (method === "thread/archived") return "archived";
  if (method === "thread/closed") return "closed";
  if (method === "thread/compacted") return "compacted";

  const statusRecord = asRecord(status);
  const statusType = asString(statusRecord?.type) ?? asString(status);
  if (statusType === "idle") return "idle";
  if (statusType === "systemError" || statusType === "error") return "error";
  return "active";
}

function turnState(value: unknown): ProviderRuntimeTurnState {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function requestTypeFromMethod(method: string): ProviderRuntimeRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function streamKindFromMethod(method: string): ProviderRuntimeContentStreamKind | null {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/plan/delta":
      return "plan_text";
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return null;
  }
}

function mapLifecycleEvent(input: CodexProviderEventInput, params: Record<string, unknown>, threadId: string) {
  const item = asRecord(params.item);
  if (!item) {
    return [];
  }

  const itemType = normalizeItemType(item.type);
  const lifecycle = input.method === "item/completed" ? "item.completed" : "item.started";
  const status: ProviderRuntimeItemStatus = lifecycle === "item.completed" ? "completed" : "in_progress";
  const detail = itemDetail(item, itemType);

  return [{
    ...baseEvent(input, params, threadId),
    type: lifecycle,
    payload: {
      itemType,
      status,
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      data: params
    }
  } satisfies ProviderRuntimeEvent];
}

function mapContentDelta(input: CodexProviderEventInput, params: Record<string, unknown>, threadId: string) {
  const streamKind = streamKindFromMethod(input.method);
  if (!streamKind) {
    return null;
  }

  const delta = decodeDelta(params);
  if (delta === null || delta.length === 0) {
    return null;
  }

  return {
    ...baseEvent(input, params, threadId),
    type: "content.delta",
    payload: {
      streamKind,
      delta,
      ...(asNumber(params.contentIndex) !== undefined ? { contentIndex: asNumber(params.contentIndex) } : {}),
      ...(asNumber(params.summaryIndex) !== undefined ? { summaryIndex: asNumber(params.summaryIndex) } : {})
    }
  } satisfies ProviderRuntimeEvent;
}

function requestDetail(method: string, params: Record<string, unknown>): string | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return trimText(params.command) ?? trimText(params.reason);
    case "item/fileRead/requestApproval":
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return trimText(params.reason) ?? trimText(params.path);
    case "execCommandApproval": {
      const command = Array.isArray(params.command) ? params.command.filter((part): part is string => typeof part === "string").join(" ") : "";
      return trimText(params.reason) ?? trimText(command);
    }
    case "item/tool/call":
      return trimText(params.tool);
    default:
      return undefined;
  }
}

export function mapCodexProviderEvent(input: CodexProviderEventInput): ProviderRuntimeEvent[] {
  const params = input.params ?? {};
  const threadId = eventThreadId(params);
  if (!threadId) {
    return [];
  }

  const deltaEvent = mapContentDelta(input, params, threadId);
  if (deltaEvent) {
    return [deltaEvent];
  }

  switch (input.method) {
    case "session/connecting":
      return [{
        ...baseEvent(input, params, threadId),
        type: "session.state.changed",
        payload: { state: "starting" }
      }];
    case "session/ready":
      return [{
        ...baseEvent(input, params, threadId),
        type: "session.state.changed",
        payload: { state: "ready" }
      }];
    case "session/exited":
    case "session/closed":
      return [{
        ...baseEvent(input, params, threadId),
        type: "session.exited",
        payload: { ...(trimText(params.message) ? { reason: trimText(params.message) } : {}) }
      }];
    case "thread/started": {
      return [{
        ...baseEvent(input, params, threadId),
        type: "thread.started",
        payload: { providerThreadId: threadId }
      }];
    }
    case "thread/settings/updated": {
      const settings = asRecord(params.threadSettings) ?? asRecord(params.settings) ?? null;
      const effort = asString(settings?.effort) ?? asString(params.effort) ?? null;
      const model = asString(settings?.model) ?? asString(params.model) ?? null;
      return [{
        ...baseEvent(input, params, threadId),
        type: "thread.settings.updated",
        payload: {
          effort: effort ?? null,
          model: model ?? null,
          metadata: params
        }
      }];
    }
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/compacted":
      return [{
        ...baseEvent(input, params, threadId),
        type: "thread.state.changed",
        payload: { state: threadState(params.status, input.method), detail: params.status ?? params }
      }];
    case "thread/name/updated": {
      const name = trimText(params.name) ?? trimText(params.threadName) ?? trimText(asRecord(params.thread)?.name);
      return [{
        ...baseEvent(input, params, threadId),
        type: "thread.metadata.updated",
        payload: { ...(name ? { name } : {}), metadata: params }
      }];
    }
    case "thread/tokenUsage/updated": {
      const tokenUsage = asRecord(params.tokenUsage);
      const total = asRecord(tokenUsage?.total);
      const last = asRecord(tokenUsage?.last);
      const tokens = asNumber(last?.totalTokens) ?? asNumber(total?.totalTokens);
      if (tokens === undefined) {
        return [];
      }
      const contextWindow = asNumber(tokenUsage?.modelContextWindow) ?? null;
      return [{
        ...baseEvent(input, params, threadId),
        type: "thread.tokenUsage.updated",
        payload: {
          tokens,
          contextWindow,
          percent: contextWindow ? (tokens / contextWindow) * 100 : null
        }
      }];
    }
    case "turn/started":
      return eventTurnId(params)
        ? [{
            ...baseEvent(input, params, threadId),
            type: "turn.started",
            payload: {
              ...(trimText(params.model) ? { model: trimText(params.model) } : {}),
              ...(trimText(params.effort) ? { effort: trimText(params.effort) } : {})
            }
          }]
        : [];
    case "turn/completed": {
      const turn = asRecord(params.turn);
      const error = asRecord(turn?.error);
      return [{
        ...baseEvent(input, params, threadId),
        type: "turn.completed",
        payload: {
          state: turnState(turn?.status),
          ...(trimText(error?.message) ? { errorMessage: trimText(error?.message) } : {})
        }
      }];
    }
    case "turn/aborted":
      return [{
        ...baseEvent(input, params, threadId),
        type: "turn.aborted",
        payload: { reason: trimText(params.reason) ?? "Turn aborted" }
      }];
    case "item/started":
    case "item/completed":
      return mapLifecycleEvent(input, params, threadId);
    case "item/commandExecution/requestApproval":
    case "item/fileRead/requestApproval":
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
    case "execCommandApproval":
    case "item/tool/call":
    case "account/chatgptAuthTokens/refresh":
      return [{
        ...baseEvent(input, params, threadId),
        type: "request.opened",
        payload: {
          requestType: requestTypeFromMethod(input.method),
          ...(requestDetail(input.method, params) ? { detail: requestDetail(input.method, params) } : {}),
          args: params
        }
      }];
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      return [{
        ...baseEvent(input, params, threadId),
        type: "userInput.requested",
        payload: { questions }
      }];
    }
    case "item/requestApproval/decision":
      return [{
        ...baseEvent(input, params, threadId),
        type: "request.resolved",
        payload: {
          requestType: requestTypeFromMethod(input.method),
          ...(trimText(params.decision) ? { decision: trimText(params.decision) } : {}),
          resolution: params
        }
      }];
    case "error":
      return [{
        ...baseEvent(input, params, threadId),
        type: "runtime.error",
        payload: { message: trimText(asRecord(params.error)?.message) ?? trimText(params.message) ?? "Codex provider error", detail: params }
      }];
    case "process/stderr":
      return [{
        ...baseEvent(input, params, threadId),
        type: "runtime.warning",
        payload: { message: trimText(params.message) ?? "Codex process stderr", detail: params }
      }];
    default:
      return [];
  }
}
