export type CodexThreadStatus = "active" | "idle" | "unknown";

export interface CodexEventEntry {
  at: number;
  method: string;
  summary: string;
}

export interface CodexItemRecord {
  id: string;
  type: string;
  status: "started" | "completed";
  text: string;
  at: number;
  raw: Record<string, unknown>;
}

export interface CodexTurnRecord {
  id: string;
  status: string;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  items: CodexItemRecord[];
}

export interface CodexContextUsageView {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface CodexCompactionView {
  active: boolean;
  count: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  source: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  status: CodexThreadStatus;
  modelProvider: string | null;
  turnCount: number;
  loaded: boolean;
  contextUsage: CodexContextUsageView;
  compaction: CodexCompactionView;
}

export interface CodexThreadRecord extends CodexThreadSummary {
  turns: CodexTurnRecord[];
  eventLog: CodexEventEntry[];
}

export interface ButlerWindow {
  threadId: string;
  title: string;
  openedAt: number;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ButlerThinkingLevel = "off" | ReasoningEffort;

export interface ModelOption {
  id: string;
  label: string;
  provider: string | null;
  supportsReasoning: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | null;
}

export interface ButlerMessageView {
  id: string;
  role: string;
  text: string;
  at: number | null;
}

export interface ButlerToolUiEffect {
  kind: "refreshThreads" | "refreshThread" | "openWindow" | "focusWindow" | "removeThread" | "removeThreads" | "focusButler";
  description: string;
}

// Butler tools declare their expected UI side effects here so agents and
// maintainers can reason about cleanup and focus changes from code alone.
export interface ButlerToolView {
  name: string;
  label: string;
  description: string;
  uiEffects: ButlerToolUiEffect[];
}

export interface ButlerAuthStatus {
  mode: "chatgpt" | "api" | "none" | "unknown";
  loggedIn: boolean;
}

export interface ButlerContextUsageView {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface ButlerCompactionView {
  autoEnabled: boolean;
  active: boolean;
  count: number;
  lastReason: "manual" | "threshold" | "overflow" | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastTokensBefore: number | null;
  lastWillRetry: boolean;
  lastAborted: boolean;
  lastError: string | null;
}

export interface AppSnapshot {
  codex: {
    connected: boolean;
    lastError: string | null;
    threads: CodexThreadSummary[];
    windows: ButlerWindow[];
    focusedWindowId: string | null;
    openThreads: Record<string, CodexThreadRecord>;
    compose: {
      model: string | null;
      effort: ReasoningEffort | null;
      availableModels: ModelOption[];
    };
  };
  butler: {
    ready: boolean;
    pending: boolean;
    isStreaming: boolean;
    sessionId: string | null;
    model: string | null;
    auth: ButlerAuthStatus;
    messages: ButlerMessageView[];
    tools: ButlerToolView[];
    contextUsage: ButlerContextUsageView;
    compaction: ButlerCompactionView;
    lastError: string | null;
    compose: {
      provider: string | null;
      model: string | null;
      thinkingLevel: ButlerThinkingLevel;
      availableThinkingLevels: ButlerThinkingLevel[];
      availableModels: ModelOption[];
    };
  };
}

export interface PersistedUiState {
  windows: ButlerWindow[];
  focusedWindowId: string | null;
}
