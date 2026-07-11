export type ProviderRuntimeHarness = "codex" | "pi" | (string & {});

export type ProviderRuntimeContentStreamKind =
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output"
  | "unknown";

export type ProviderRuntimeItemType =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "plan"
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
  | "context_compaction"
  | "error"
  | "unknown";

export type ProviderRuntimeItemStatus = "in_progress" | "completed" | "failed" | "declined";
export type ProviderRuntimeThreadState = "active" | "idle" | "archived" | "closed" | "compacted" | "error";
export type ProviderRuntimeTurnState = "completed" | "failed" | "interrupted" | "cancelled";
export type ProviderRuntimeSessionState = "starting" | "ready" | "running" | "waiting" | "stopped" | "error";

export type ProviderRuntimeRequestType =
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "apply_patch_approval"
  | "exec_command_approval"
  | "tool_user_input"
  | "dynamic_tool_call"
  | "auth_tokens_refresh"
  | "unknown";

export type ProviderRuntimeRawEvent = {
  source: `${string}.${string}` | string;
  method: string;
  payload: unknown;
};

export type ProviderRuntimeRefs = {
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  providerRequestId?: string;
};

export type ProviderRuntimeBaseEvent = {
  id: string;
  type: string;
  harness: ProviderRuntimeHarness;
  providerInstanceId?: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  at: number;
  providerRefs?: ProviderRuntimeRefs;
  raw?: ProviderRuntimeRawEvent;
};

export type ProviderRuntimeEvent =
  | (ProviderRuntimeBaseEvent & {
      type: "session.started";
      payload: { message?: string; resume?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "session.state.changed";
      payload: { state: ProviderRuntimeSessionState; reason?: string; detail?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "session.exited";
      payload: { reason?: string; recoverable?: boolean };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "thread.started";
      payload: { providerThreadId?: string };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "thread.state.changed";
      payload: { state: ProviderRuntimeThreadState; detail?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "thread.metadata.updated";
      payload: { name?: string; effort?: string | null; model?: string | null; metadata?: Record<string, unknown> };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "thread.settings.updated";
      payload: { effort: string | null; model?: string | null; metadata?: Record<string, unknown> };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "thread.tokenUsage.updated";
      payload: { tokens: number; contextWindow: number | null; percent: number | null };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "turn.started";
      payload: { model?: string; effort?: string };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "turn.completed";
      payload: { state: ProviderRuntimeTurnState; errorMessage?: string };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "turn.aborted";
      payload: { reason: string };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "item.started" | "item.updated" | "item.completed";
      payload: {
        itemType: ProviderRuntimeItemType;
        status?: ProviderRuntimeItemStatus;
        title?: string;
        detail?: string;
        data?: unknown;
      };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "content.delta";
      payload: {
        streamKind: ProviderRuntimeContentStreamKind;
        delta: string;
        contentIndex?: number;
        summaryIndex?: number;
      };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "request.opened";
      payload: { requestType: ProviderRuntimeRequestType; detail?: string; args?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "request.resolved";
      payload: { requestType: ProviderRuntimeRequestType; decision?: string; resolution?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "userInput.requested";
      payload: { questions: unknown[] };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "userInput.resolved";
      payload: { answers: Record<string, unknown> };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "runtime.warning";
      payload: { message: string; detail?: unknown };
    })
  | (ProviderRuntimeBaseEvent & {
      type: "runtime.error";
      payload: { message: string; detail?: unknown };
    });

export type ProviderRuntimePatchTelemetry = {
  id: string;
  provider: string;
  providerEventAt: number;
  serverReceivedAt: number;
  serverSentAt?: number;
};

type ProviderRuntimeLivePatchTelemetry = {
  telemetry?: ProviderRuntimePatchTelemetry;
};

export type ProviderRuntimeLivePatch =
  | ({
      kind: "content-delta";
      threadId: string;
      turnId: string;
      itemId: string;
      itemType: ProviderRuntimeItemType;
      streamKind: ProviderRuntimeContentStreamKind;
      delta: string;
      itemTextLength: number;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry)
  | ({
      kind: "item-lifecycle";
      threadId: string;
      turnId: string;
      itemId: string;
      itemType: ProviderRuntimeItemType;
      status: ProviderRuntimeItemStatus;
      title?: string;
      text: string;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry)
  | ({
      kind: "turn-lifecycle";
      threadId: string;
      turnId: string;
      status: "started" | ProviderRuntimeTurnState;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry)
  | ({
      kind: "thread-state";
      threadId: string;
      state: ProviderRuntimeThreadState;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry)
  | ({
      kind: "token-usage";
      threadId: string;
      tokens: number;
      contextWindow: number | null;
      percent: number | null;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry)
  | ({
      kind: "runtime-message";
      threadId: string;
      tone: "warning" | "error";
      message: string;
      at: number;
    } & ProviderRuntimeLivePatchTelemetry);

export type ProviderRuntimeThreadSnapshot = {
  threadId: string;
  thread?: unknown;
  turns: Array<{ id: string; items: unknown[] }>;
};

export type ProviderRuntimeThreadResult = {
  threadId: string;
  thread?: unknown;
};

export type ProviderRuntimeTurnResult = {
  threadId: string;
  turnId?: string;
  turn?: unknown;
};

export type ProviderRuntimeAdapter = {
  harness: ProviderRuntimeHarness;
  startThread(input: Record<string, unknown>): Promise<ProviderRuntimeThreadResult>;
  resumeThread(threadId: string, input?: Record<string, unknown>): Promise<ProviderRuntimeThreadResult>;
  loadThread(threadId: string, input?: Record<string, unknown>): Promise<ProviderRuntimeThreadSnapshot>;
  sendTurn(threadId: string, input: Record<string, unknown>): Promise<ProviderRuntimeTurnResult>;
  steerTurn(threadId: string, turnId: string, input: unknown): Promise<void>;
  interruptTurn(threadId: string, turnId?: string): Promise<void>;
  unsubscribeThread(threadId: string): Promise<void>;
  respondToRequest?(threadId: string, requestId: string, response: Record<string, unknown>): Promise<void>;
  stopThread?(threadId: string): Promise<void>;
  onRuntimeEvent(listener: (event: ProviderRuntimeEvent) => void): () => void;
};
