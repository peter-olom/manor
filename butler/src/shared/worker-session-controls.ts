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

export type WorkerSessionControls = {
  supported: boolean;
  runtime: "pi" | "codex";
  busy: boolean;
  compacting: boolean;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
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
