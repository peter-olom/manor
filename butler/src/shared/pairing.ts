export type PairRole = "user" | "butler" | "worker" | "system";
export type PairLane = "butler" | "worker";
export type PairStatus = "idle" | "butler_running" | "worker_running" | "needs_butler_review" | "blocked";
export type PairViewMode = "butler" | "worker" | "split" | "memory";

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
};

export type PairWorker = {
  threadId: string;
  status: "starting" | "running" | "idle" | "blocked" | "unknown";
  task: string;
  cwd: string | null;
  handoffPrompt: string;
  startedAt: number;
  lastRevertAt: number | null;
  lastReportAt: number | null;
  lastReportStatus: "completed" | "blocked" | null;
  lastReportSummary: string | null;
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
  butlerLastError: string | null;
  worker: PairWorker | null;
  memoryQuery: string | null;
  lastHandoffPrompt: string | null;
  messageCount: number;
  lastMessage: PairMessage | null;
};

export type PairSummary = PairChat;

export type PairDetail = PairChat & {
  messages: PairMessage[];
  loadedStart: number;
  hasMore: boolean;
};

export type PairListResponse = {
  pairs: PairSummary[];
};

export type PairDetailResponse = {
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
