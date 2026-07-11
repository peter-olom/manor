export type PairRole = "user" | "butler" | "worker" | "system";
export type PairLane = "butler" | "worker";
export type PairStatus = "idle" | "butler_running" | "worker_running" | "needs_butler_review" | "blocked";
export type PairViewMode = "butler" | "worker" | "split" | "memory" | "improve" | "settings" | "cli";
export type PairWorkerRuntime = "openai" | "pi-rpc";
export type PairWorkerHarness = "codex" | "pi" | (string & {});

export const DEFAULT_THINKING_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh"];
export const BUTLER_THINKING_LEVELS: readonly string[] = ["off", "default", "none", "minimal", ...DEFAULT_THINKING_LEVELS, "max", "thinking"];
export const REASONING_EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isKnownThinkingLevel(value: string): boolean {
  return BUTLER_THINKING_LEVELS.includes(value);
}

export function isKnownReasoningEffort(value: string): boolean {
  return REASONING_EFFORTS.includes(value);
}

export type PairTraceItemType =
  | "reasoning"
  | "command_execution"
  | "file_change"
  | "plan"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "web_search"
  | "image_view"
  | "context_compaction"
  | "user_message"
  | "assistant_message"
  | "error"
  | "unknown";

export type PairTraceItemStatus = "in_progress" | "completed" | "failed" | "declined";

export type PairTraceItem = {
  id: string;
  type: PairTraceItemType;
  status: PairTraceItemStatus;
  text: string;
  title?: string;
  at: number;
  completedAt?: number | null;
};

export type PairMessage = {
  id: string;
  role: PairRole;
  lane: PairLane;
  text: string;
  at: number;
  sourceThreadId: string | null;
  memoryObservationId: string | null;
  metadata: Record<string, string>;
  pending?: boolean;
  trace?: PairTraceItem[];
};

export type PairWorker = {
  threadId: string;
  runtime?: PairWorkerRuntime | null;
  harness?: PairWorkerHarness | null;
  provider?: string | null;
  model?: string | null;
  status: "starting" | "running" | "idle" | "blocked" | "unknown";
  task: string;
  cwd: string | null;
  handoffPrompt: string;
  startedAt: number;
  lastRevertAt: number | null;
  lastReportAt: number | null;
  lastReportStatus: "completed" | "blocked" | null;
  lastReportSummary: string | null;
  lastReviewedReportAt: number | null;
  requestedReasoningEffort?: string | null;
  handedOffFrom?: {
    threadId: string;
    runtime: PairWorkerRuntime | null;
    harness: PairWorkerHarness | null;
    provider: string | null;
    model: string | null;
  } | null;
};

export type PairModelOption = {
  id: string;
  label: string;
  provider: string | null;
  harness?: PairWorkerHarness | null;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: string[];
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
};

export type PairChat = {
  id: string;
  title: string;
  status: PairStatus;
  projectId: string | null;
  projectLabel: string | null;
  createdAt: number;
  updatedAt: number;
  defaultCwd: string | null;
  butlerSessionId: string | null;
  butlerReady: boolean;
  butlerPending: boolean;
  butlerPendingReason: string | null;
  butlerLastError: string | null;
  worker: PairWorker | null;
  memoryQuery: string | null;
  lastHandoffPrompt: string | null;
  messageCount: number;
  lastMessage: PairMessage | null;
  butlerThinkingLevel?: string | null;
  butlerModel?: string | null;
  workerHarness?: PairWorkerHarness | null;
  workerModel?: string | null;
  workerEffort?: string | null;
};

export type PairSummary = PairChat;

export type PairComposeSettings = {
  butler: {
    provider: string | null;
    model: string | null;
    thinkingLevel: string;
    availableModels: PairModelOption[];
    availableThinkingLevels: string[];
  };
  worker: {
    runtime: "auto" | PairWorkerRuntime;
    harness: PairWorkerHarness | null;
    provider: string | null;
    model: string | null;
    effort: string | null;
    availableModels: PairModelOption[];
    availableEfforts: string[];
  };
};

export type PairDetail = PairChat & {
  messages: PairMessage[];
  loadedStart: number;
  hasMore: boolean;
  compose: PairComposeSettings;
};

export type PairListResponse = {
  pairs: PairSummary[];
};

export type PairDetailResponse = {
  pair: PairDetail;
};

export type PairSettingsResponse = {
  pair: PairDetail;
};

export type PairMemoryCard = {
  id: string;
  kind: "project" | "job" | "butler" | "warning";
  title: string;
  body: string;
  meta: string | null;
};

export type PairMemoryResponse = {
  cards: PairMemoryCard[];
};

export type PairWorkerThreadResponse = {
  thread: unknown | null;
};
