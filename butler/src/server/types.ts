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

export interface CodexSupervisionView {
  butlerTurnsUsed: number;
  maxButlerTurns: number | null;
  capReached: boolean;
}

export type PreviewLeaseStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
export type PreviewEgressProfile = string;
export type ServiceLeaseStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
export type LeaseLifecycleState = "starting" | "active" | "idle" | "stopping" | "expired";

export interface LeaseLifecycleView {
  pinned?: boolean;
  lastActivityAt?: number;
  leaseTtlMs?: number | null;
  expiresAt?: number | null;
  expiredAt?: number | null;
  reapAfterAt?: number | null;
  lifecycleState?: LeaseLifecycleState;
}

export interface PreviewLeaseView extends LeaseLifecycleView {
  id: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  title: string;
  worktreePath: string;
  branchName: string | null;
  containerName: string;
  targetHost: string;
  targetPort: number;
  routePrefix: string;
  operatorUrl: string;
  command: string;
  image: string;
  egressProfile: PreviewEgressProfile;
  egressDomains: string[];
  status: PreviewLeaseStatus;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface ServiceTemplateView {
  id: string;
  label: string;
  description: string;
  runtimeKind: "container" | "embedded";
  engine: string;
  image: string;
  defaultPort: number;
  notes: string | null;
}

export interface ServiceConnectionView {
  engine: string;
  host: string;
  port: number;
  database: string | null;
  username: string | null;
  password: string | null;
  uri: string | null;
  notes: string | null;
}

export interface ServiceLeaseView extends LeaseLifecycleView {
  id: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  title: string;
  templateId: string;
  templateLabel: string;
  runtimeKind: "container" | "embedded";
  containerName: string;
  targetHost: string;
  targetPort: number;
  worktreePath: string | null;
  image: string;
  status: ServiceLeaseStatus;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  connection: ServiceConnectionView;
}

export type CodexMilestoneType = "started" | "completed" | "blocked";

export interface CodexMilestoneEntry {
  id: string;
  at: number;
  type: CodexMilestoneType;
  threadId: string;
  projectId: string;
  summary: string;
}

export interface CodexThreadSupervisorView {
  projectId: string;
  projectLabel: string;
  latestUserPrompt: string | null;
  latestAgentReply: string | null;
  summary: string;
  blocked: boolean;
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
  supervision: CodexSupervisionView;
  supervisor: CodexThreadSupervisorView;
}

export interface CodexThreadRecord extends CodexThreadSummary {
  turns: CodexTurnRecord[];
  eventLog: CodexEventEntry[];
  milestones: CodexMilestoneEntry[];
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

export interface CodexProjectSummaryView {
  id: string;
  label: string;
  threadCount: number;
  activeCount: number;
  blockedCount: number;
  completedCount: number;
  updatedAt: number;
  summary: string;
  threadIds: string[];
}

export interface ButlerSupervisorSummaryView {
  totalThreads: number;
  activeThreads: number;
  blockedThreads: number;
  completedThreads: number;
  projectCount: number;
  updatedAt: number;
  summary: string;
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

export type OnboardingStepStatus = "complete" | "pending";
export type OnboardingCommandTarget = "localShell" | "butlerTerminal" | "codexTerminal";

export interface OnboardingCommandSet {
  target: OnboardingCommandTarget;
  detail: string;
  commands: string[];
}

export interface OnboardingStepView {
  id: "butlerAuth" | "codexAuth" | "githubAuth";
  title: string;
  status: OnboardingStepStatus;
  detail: string;
  commandSets: OnboardingCommandSet[];
}

export interface ButlerOnboardingView {
  complete: boolean;
  steps: OnboardingStepView[];
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
    onboarding: ButlerOnboardingView;
    contextUsage: ButlerContextUsageView;
    compaction: ButlerCompactionView;
    supervision: {
      projects: CodexProjectSummaryView[];
      supervisor: ButlerSupervisorSummaryView;
      notices: ButlerMessageView[];
    };
    previews: PreviewLeaseView[];
    serviceTemplates: ServiceTemplateView[];
    services: ServiceLeaseView[];
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
  previewLeases?: PreviewLeaseView[];
  serviceLeases?: ServiceLeaseView[];
  supervisionByThreadId?: Record<
    string,
    {
      butlerTurnsUsed?: number;
      maxButlerTurns?: number | null;
    }
  >;
}
