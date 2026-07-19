import type { ManorRestartRequestView } from "./manor-restart.js";

export type PairRole = "user" | "butler" | "worker" | "system";
export type PairLane = "butler" | "worker";
export type PairStatus = "idle" | "butler_running" | "worker_running" | "needs_butler_review" | "blocked";
export type PairViewMode = "butler" | "worker" | "split" | "files" | "memory" | "improve" | "settings" | "cli";
export type PairWorkerRuntime = "pi-rpc";
export type PairWorkerHarness = "pi";

export type PairComposerInputItem =
  | { type: "file"; name: string; path: string }
  | { type: "skill"; name: string; path?: string; id?: string; environment?: "butler-pi" | "worker-pi" }
  | { type: "mention"; name?: string; path: string };

export type PairComposerSuggestion = {
  id: string;
  kind: "file" | "directory" | "skill" | "app" | "command" | "action";
  label: string;
  detail: string | null;
  insertText: string;
  inputItem?: PairComposerInputItem;
};

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
  updatedAt?: number;
  completedAt?: number | null;
};

export type PairButlerActivityOutcome = {
  status: "active" | "completed" | "failed" | "interrupted" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  detail: string | null;
};

export type PairReviewStage = "queued" | "preparing" | "reviewing_changes" | "supervising_closeout" | "retry_wait" | "blocked";

export type PairReviewActivity = {
  state: "queued" | "running" | "blocked";
  stage: PairReviewStage;
  attempt: number;
  maxAttempts: number;
  startedAt: number | null;
  deadlineAt: number | null;
  nextAttemptAt: number | null;
  lastActivityAt: number | null;
  lastActivity: string | null;
  lastTool: string | null;
  lastError: string | null;
  errors: Array<{ at: number; stage: PairReviewStage; tool: string | null; message: string }>;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  retryable: boolean;
};

export type PairOperatorQuestionOption = {
  id: string;
  label: string;
  description: string | null;
};

export type PairOperatorQuestionItem = {
  id: string;
  prompt: string;
  context: string | null;
  options: PairOperatorQuestionOption[];
  allowFreeform: boolean;
  createdAt: number;
  selectedOptionId?: string | null;
  freeformAnswer?: string | null;
  answeredAt?: number | null;
};

export type PairOperatorQuestion = PairOperatorQuestionItem & {
  questions?: PairOperatorQuestionItem[];
  deliveryState?: "idle" | "pending" | "delivered" | "failed";
  deliveryError?: string | null;
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
  question?: PairOperatorQuestion;
  attachments?: PairMessageAttachment[];
};

export type PairMessageAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  downloadUrl?: string;
};

export type PairWorkerHandoff = {
  threadId: string;
  runtime: PairWorkerRuntime | null;
  harness: PairWorkerHarness | null;
  provider: string | null;
  model: string | null;
  handedOffFrom?: PairWorkerHandoff | null;
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
  handedOffFrom?: PairWorkerHandoff | null;
};

export type PairWorkspaceOption = {
  id: string;
  label: string;
  cwd: string;
  kind: "project" | "workspace";
  gitBacked: boolean;
};

export type PairWorkspaceListResponse = {
  workspaces: PairWorkspaceOption[];
};

export type PairAutomationOutcome = "succeeded" | "failed" | "skipped" | "needs_input";

export type PairAutomationRun = {
  id: string;
  scheduledFor: number;
  startedAt: number;
  /**
   * The normalized local occurrence key captured at claim time. Legacy daily
   * schedules store HH:mm; newer calendar schedules may include the local anchor
   * date. Used to prevent a timezone change from replaying an occurrence.
   */
  scheduledSlot?: string | null;
};

export type PairAutomationLastRun = PairAutomationRun & {
  finishedAt: number;
  outcome: PairAutomationOutcome;
  summary: string;
  resultPath: string | null;
};

export type PairAutomationSchedule =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; times: string[]; endsOn?: string | null }
  | { kind: "weekly"; weekdays: PairAutomationWeekday[]; times: string[]; endsOn?: string | null }
  | { kind: "window"; everyMinutes: number; startTime: string; endTime: string; endsOn?: string | null }
  | { kind: "interval"; everyMinutes: number; startsAt: number; endsAt: number };

export type PairAutomationWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type PairAutomationState = "active" | "running" | "paused" | "completed";

export type PairAutomation = {
  id: string;
  instruction: string;
  schedule: PairAutomationSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  /** Configured HH:mm wall-clock slot associated with the next calendar run. */
  nextRunSlot?: string | null;
  running: PairAutomationRun | null;
  lastRun: PairAutomationLastRun | null;
  state: PairAutomationState;
  scheduleLabel: string;
  endsAtLabel: string | null;
  nextRunLabel: string | null;
  lastRunLabel: string | null;
};

export type PairModelOption = {
  id: string;
  label: string;
  provider: string | null;
  harness?: PairWorkerHarness | null;
  inputCapabilities?: {
    image: "supported" | "unsupported" | "unknown";
    source: "override" | "provider" | "manifest" | "unknown";
  };
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
  automation: PairAutomation | null;
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
  butlerActivity: PairTraceItem[];
  butlerActivityOutcome: PairButlerActivityOutcome | null;
  review: PairReviewActivity | null;
  pendingManorRestartRequest: ManorRestartRequestView | null;
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
  proofRecords: unknown[];
};
