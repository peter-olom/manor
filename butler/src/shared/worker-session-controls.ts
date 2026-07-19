import type { ModelUsageSummary } from "./model-usage.js";

export type WorkerSessionStats = {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  usage: ModelUsageSummary;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
};

export type WorkerSessionForkPoint = {
  entryId: string;
  text: string;
};

export type WorkerCompactionOperation = {
  id: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: number;
  completedAt: number | null;
  error: string | null;
};

export type WorkerSessionControls = {
  supported: boolean;
  runtime: "pi";
  busy: boolean;
  compacting: boolean;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
  manualCompaction: WorkerCompactionOperation | null;
  sessionName: string | null;
  stats: WorkerSessionStats | null;
  forkPoints: WorkerSessionForkPoint[];
  leafId: string | null;
};

export type WorkerSessionControlAction =
  | "compact"
  | "abort-retry"
  | "fork"
  | "clone"
  | "rename";
