export type CodexThreadStatus = "active" | "idle" | "unknown";
export type CodexProofExpectation = "none" | "requested";
export type ButlerCallbackState =
  | "waiting"
  | "received_worker_callback"
  | "missing_worker_callback"
  | "recovered_from_thread_state"
  | "closed";
export type ButlerCallbackResolutionState = "received_worker_callback" | "recovered_from_thread_state" | null;
export type ButlerOperatorCloseoutStatus = "not_required" | "owed" | "posted";
export type ButlerCloseoutChannel = "none" | "main_chat";
export type ButlerNextWorkerReportAction = "review" | "reply_to_operator";
export type ButlerCallbackReviewState = "idle" | "queued" | "running";
export type ButlerCallbackReviewReason = "worker_callback" | "thread_recovery" | null;

export interface CodexThreadExecutionContractView {
  threadId: string;
  workspaceCwd: string | null;
  projectId: string;
  projectLabel: string;
  branch: string | null;
  requestedTask: string;
  operatorGoal: string | null;
  acceptancePoints: string[];
  proofExpectation: CodexProofExpectation;
  proofExpectationLabel: string;
  notes: string[];
}

export interface ButlerThreadCallbackView {
  threadId: string;
  callbackState: ButlerCallbackState;
  resolutionState: ButlerCallbackResolutionState;
  requestedAt: number;
  lastEventAt: number | null;
  lastWorkerStatusSeen: CodexThreadStatus | null;
  lastTerminalReportAt: number | null;
  lastPrivateSteerText: string | null;
  lastPrivateSteerAt: number | null;
  nextWorkerReportAction: ButlerNextWorkerReportAction;
  operatorCloseoutStatus: ButlerOperatorCloseoutStatus;
  owesOperatorReply: boolean;
  closeoutChannel: ButlerCloseoutChannel;
  reviewState: ButlerCallbackReviewState;
  reviewReason: ButlerCallbackReviewReason;
  closedAt: number | null;
  updatedAt: number;
}

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

export type CodexWorkerReportStatus = "completed" | "blocked";

export interface CodexWorkerReportView {
  threadId: string;
  turnId: string;
  status: CodexWorkerReportStatus;
  summary: string;
  details: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SupervisionChecklistItemStatus = "pending" | "accepted" | "rejected" | "waived";
export type SupervisionChecklistEvidenceSource = "worker_report" | "butler_review";

export interface SupervisionChecklistEvidenceView {
  id: string;
  source: SupervisionChecklistEvidenceSource;
  summary: string;
  details: string | null;
  reportTurnId: string | null;
  createdAt: number;
}

export interface SupervisionChecklistItemView {
  id: string;
  text: string;
  status: SupervisionChecklistItemStatus;
  butlerNote: string | null;
  queuedInstruction: string | null;
  decidedAt: number | null;
  evidence: SupervisionChecklistEvidenceView[];
}

export interface SupervisionChecklistHeartbeatView {
  lastThreadEventAt: number | null;
  lastWorkerReportAt: number | null;
  lastKnownThreadStatus: CodexThreadStatus;
  stale: boolean;
}

export interface SupervisionChecklistView {
  threadId: string;
  projectId: string;
  projectLabel: string;
  requestedTask: string;
  items: SupervisionChecklistItemView[];
  heartbeat: SupervisionChecklistHeartbeatView;
  reviewState: "needs_review" | "reviewed";
  createdAt: number;
  updatedAt: number;
}

export type PreviewLeaseStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
export type PreviewEgressProfile = string;
export type ServiceLeaseStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
export type StackLeaseStatus = "running" | "stopping" | "stopped" | "degraded";
export type StackStorageMode = "ephemeral" | "job" | "base" | "custom";
export type LeaseLifecycleState = "starting" | "active" | "idle" | "stopping" | "expired";
export type PreviewBootstrapHeartbeatKind = "none" | "http" | "tcp" | "command";
export type PreviewBootstrapPhase =
  | "pulling_image"
  | "starting_container"
  | "bootstrapping"
  | "waiting_for_heartbeat"
  | "ready"
  | "failed";

export type PreviewVerificationArtifactKind = "manifest" | "screenshot" | "video" | "trace" | "html" | "other";
export type PreviewVerificationArtifactAvailability = "available" | "expired" | "missing";
export type PreviewBrowserMode = "headless" | "headful";
export type PreviewVerificationFailureKind =
  | "none"
  | "preview"
  | "http"
  | "auth"
  | "readiness"
  | "verifier"
  | "script"
  | "artifact"
  | "unknown";
export type PreviewVerificationPhaseStatus = "completed" | "failed" | "skipped";

export interface PreviewVerificationArtifactView {
  kind: PreviewVerificationArtifactKind;
  label: string;
  fileName: string;
  filePath: string;
  contentType: string;
  sizeBytes: number | null;
  url: string | null;
  downloadUrl: string | null;
  availability: PreviewVerificationArtifactAvailability;
  retainedUntilAt: number | null;
  expiredAt: number | null;
}

export interface PreviewVerificationConsoleMessageView {
  type: string;
  text: string;
  location: string | null;
}

export interface PreviewVerificationFailedRequestView {
  url: string;
  method: string;
  errorText: string | null;
}

export interface PreviewVerificationSummaryView {
  consoleMessageCount: number;
  pageErrorCount: number;
  failedRequestCount: number;
  responseErrorCount: number;
  assetFailureCount: number;
  phaseCount: number;
}

export interface PreviewVerificationPhaseView {
  name: string;
  label: string;
  status: PreviewVerificationPhaseStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  message: string | null;
}

export interface PreviewVerificationReadinessView {
  initialUrl: string;
  finalUrl: string;
  expectedPath: string | null;
  selector: string | null;
  selectorSatisfied: boolean | null;
  routeStatus: number | null;
  routeOk: boolean;
  loginRedirectDetected: boolean;
  htmlErrorSignals: string[];
  sameOriginAssetFailureCount: number;
  websocketFailureCount: number;
  notes: string[];
}

export interface PreviewVerificationAuthView {
  headerCount: number;
  cookieCount: number;
  cookieNames: string[];
  usedSessionCookie: boolean;
}

export interface PreviewVerificationDiagnosticStageView {
  name: string;
  ok: boolean | null;
  detail: string;
  status: number | null;
  hint: string | null;
  failureKind: PreviewVerificationFailureKind | null;
}

export interface PreviewVerificationDiagnosticsView {
  stages: {
    processUp: PreviewVerificationDiagnosticStageView | null;
    networkReachable: PreviewVerificationDiagnosticStageView | null;
    routeAuth: PreviewVerificationDiagnosticStageView | null;
    uiSelectorVisible: PreviewVerificationDiagnosticStageView | null;
  };
  remediationHints: string[];
}

export interface PreviewVerificationView {
  runId: string;
  mode: PreviewBrowserMode;
  checkedAt: number;
  durationMs: number;
  ok: boolean;
  status: number | null;
  title: string;
  url: string;
  error: string | null;
  failureKind: PreviewVerificationFailureKind;
  summary: PreviewVerificationSummaryView;
  phases: PreviewVerificationPhaseView[];
  readiness: PreviewVerificationReadinessView;
  auth: PreviewVerificationAuthView;
  diagnostics?: PreviewVerificationDiagnosticsView;
  artifacts: PreviewVerificationArtifactView[];
  consoleMessages: PreviewVerificationConsoleMessageView[];
  pageErrors: string[];
  failedRequests: PreviewVerificationFailedRequestView[];
}

export interface PreviewProofRecordView {
  id: string;
  previewId: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  previewTitle: string;
  stackId: string | null;
  verification: PreviewVerificationView;
  createdAt: number;
  updatedAt: number;
}

export interface LeaseLifecycleView {
  pinned?: boolean;
  lastActivityAt?: number;
  ttlAnchorAt?: number;
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
  stackId: string | null;
  aliases: string[];
  worktreePath: string;
  branchName: string | null;
  containerName: string;
  targetHost: string;
  targetPort: number;
  publicPort: number | null;
  publicUrl: string | null;
  tailnetUrl: string | null;
  routePrefix: string;
  operatorUrl: string;
  command: string;
  workspaceMode: "shared" | "snapshot";
  image: string;
  egressProfile: PreviewEgressProfile;
  egressDomains: string[];
  status: PreviewLeaseStatus;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  lastVerification?: PreviewVerificationView | null;
  bootstrap: {
    waitSeconds: number;
    hint: string | null;
    heartbeatKind: PreviewBootstrapHeartbeatKind;
    heartbeatTarget: string | null;
    heartbeatIntervalSeconds: number;
    phase: PreviewBootstrapPhase;
    startedAt: number | null;
    readyAt: number | null;
    lastHeartbeatAt: number | null;
    lastHeartbeatError: string | null;
  };
}

export interface ServiceTemplateView {
  id: string;
  label: string;
  description: string;
  runtimeKind: "container" | "embedded";
  engine: string;
  image: string;
  defaultPort: number;
  stackVolumePath: string | null;
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
  stackId: string | null;
  aliases: string[];
  templateId: string;
  templateLabel: string;
  runtimeKind: "container" | "embedded";
  containerName: string;
  targetHost: string;
  targetPort: number;
  worktreePath: string | null;
  image: string;
  status: ServiceLeaseStatus;
  storageKind: "ephemeral" | "volume" | "worktree";
  sticky: boolean;
  volumeName: string | null;
  volumeMountPath: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  connection: ServiceConnectionView;
}

export interface StackLeaseView extends LeaseLifecycleView {
  id: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  title: string;
  worktreePath: string | null;
  networkName: string;
  status: StackLeaseStatus;
  storageMode: StackStorageMode;
  retainsVolumes: boolean;
  baseStorageKey: string | null;
  storageKey: string | null;
  cloneFromStorageKey: string | null;
  defaultPromoteTargetStorageKey: string | null;
  volumeNames: string[];
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  previewIds: string[];
  serviceIds: string[];
}

export interface RuntimeCleanupTaskView {
  id: string;
  threadId: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attempts: number;
  lastError: string | null;
  notifyOnError: boolean;
  stacks: Array<{
    id: string;
    retainsVolumes: boolean;
    status: StackLeaseStatus;
  }>;
  previews: Array<{
    id: string;
    stackId: string | null;
    status: PreviewLeaseStatus;
  }>;
  services: Array<{
    id: string;
    stackId: string | null;
    runtimeKind: "container" | "embedded";
    status: ServiceLeaseStatus;
  }>;
}

export type CodexMilestoneType = "started" | "completed" | "blocked";

export interface CodexMilestoneEntry {
  id: string;
  at: number;
  type: CodexMilestoneType;
  threadId: string;
  turnId: string;
  projectId: string;
  summary: string;
}

export type JobMemoryEntryKind = "checkpoint" | "decision" | "note";
export type JobMemoryPromotionCandidateStatus = "pending" | "accepted" | "rejected";

export interface JobMemoryDecisionView {
  id: string;
  summary: string;
  details: string | null;
  at: number;
}

export interface JobMemoryPromotionCandidateView {
  id: string;
  threadId: string;
  projectId: string;
  projectLabel: string;
  kind: JobMemoryEntryKind;
  sourceEntryId: string;
  summary: string;
  details: string | null;
  status: JobMemoryPromotionCandidateStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface JobMemoryEntryView {
  id: string;
  kind: JobMemoryEntryKind;
  summary: string;
  details: string | null;
  nextAction: string | null;
  blockers: string[];
  plan: string[];
  assumptions: string[];
  proofRequirements: string[];
  promote: boolean;
  promotionCandidateId: string | null;
  at: number;
}

export interface JobMemoryView {
  threadId: string;
  projectId: string;
  projectLabel: string;
  operatorGoal: string | null;
  requestedTask: string | null;
  currentPlan: string[];
  latestCheckpoint: string | null;
  nextAction: string | null;
  blockers: string[];
  assumptions: string[];
  proofRequirements: string[];
  notes: string[];
  decisions: JobMemoryDecisionView[];
  entries: JobMemoryEntryView[];
  promotionCandidates: JobMemoryPromotionCandidateView[];
  updatedAt: number;
}

export interface ProjectMemoryEntryView {
  id: string;
  sourceThreadId: string;
  kind: JobMemoryEntryKind;
  summary: string;
  details: string | null;
  acceptedAt: number;
}

export interface ProjectMemoryView {
  projectId: string;
  projectLabel: string;
  summary: string | null;
  entries: ProjectMemoryEntryView[];
  updatedAt: number;
}

export interface ButlerMemoryEntryView {
  id: string;
  summary: string;
  details: string | null;
  source: "butler_tool" | "manual_chat_save";
  sourceMessageId: string | null;
  tags: string[];
  createdAt: number;
}

export type ProjectArtifactKind = "seed" | "reference" | "download" | "research" | "report" | "other";
export type ProjectArtifactSourceKind = "inline" | "url" | "generated";

export interface ProjectArtifactView {
  id: string;
  projectId: string;
  projectLabel: string;
  kind: ProjectArtifactKind;
  title: string;
  description: string | null;
  fileName: string;
  filePath: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  metadata: Record<string, string>;
  source: {
    kind: ProjectArtifactSourceKind;
    url: string | null;
    createdByThreadId: string | null;
    checksumSha256: string | null;
  };
  textPreview: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectPolicyView {
  id: string;
  projectId: string;
  projectLabel: string;
  title: string;
  instruction: string;
  artifacts: string[];
  triggers: string[];
  createdAt: number;
  updatedAt: number;
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
  name: string | null;
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
  executionContract: CodexThreadExecutionContractView | null;
  supervisionChecklist: SupervisionChecklistView | null;
  jobMemory: JobMemoryView | null;
}

export interface CodexThreadRecord extends CodexThreadSummary {
  turns: CodexTurnRecord[];
  eventLog: CodexEventEntry[];
  milestones: CodexMilestoneEntry[];
  workerReport: CodexWorkerReportView | null;
}

export interface CodexItemView {
  id: string;
  type: string;
  status: "started" | "completed";
  text: string;
  at: number;
}

export interface CodexTurnView {
  id: string;
  status: string;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  items: CodexItemView[];
}

export interface CodexThreadDetailView extends CodexThreadSummary {
  turns: CodexTurnView[];
  eventLog: CodexEventEntry[];
  workerReport: CodexWorkerReportView | null;
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
  kind: "message";
}

export interface ButlerMessagePageView {
  messages: ButlerMessageView[];
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasMore: boolean;
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
  memorySummary: string | null;
  pendingPromotionCount: number;
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
  validationError: string | null;
  lastValidatedAt: number | null;
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
    auth: ButlerAuthStatus;
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
    messageCount: number;
    tools: ButlerToolView[];
    onboarding: ButlerOnboardingView;
    contextUsage: ButlerContextUsageView;
    compaction: ButlerCompactionView;
    supervision: {
      projects: CodexProjectSummaryView[];
      supervisor: ButlerSupervisorSummaryView;
      callbacks: ButlerThreadCallbackView[];
    };
    latestPreviewProofsByThreadId: Record<string, PreviewProofRecordView>;
    previewProofsByThreadId: Record<string, PreviewProofRecordView[]>;
    stacks: StackLeaseView[];
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

export interface AppShellSnapshot {
  codex: AppSnapshot["codex"] extends infer TCodex
    ? TCodex extends { openThreads: unknown }
      ? Omit<TCodex, "openThreads">
      : never
    : never;
  butler: AppSnapshot["butler"] extends infer TButler
      ? TButler extends {
        messages: unknown;
        messageCount: unknown;
        latestPreviewProofsByThreadId: unknown;
        previewProofsByThreadId: unknown;
        stacks: unknown;
        previews: unknown;
        serviceTemplates: unknown;
        services: unknown;
      }
      ? Omit<TButler, "messages" | "messageCount" | "latestPreviewProofsByThreadId" | "previewProofsByThreadId" | "stacks" | "previews" | "serviceTemplates" | "services">
      : never
    : never;
}

export interface ButlerLiveSnapshot {
  messages: ButlerMessageView[];
  messageCount: number;
}

export interface RuntimeSnapshot {
  latestPreviewProofsByThreadId: Record<string, PreviewProofRecordView>;
  previewProofsByThreadId: Record<string, PreviewProofRecordView[]>;
  stacks: StackLeaseView[];
  previews: PreviewLeaseView[];
  serviceTemplates: ServiceTemplateView[];
  services: ServiceLeaseView[];
}

export interface AppBootstrapSnapshot {
  shell: AppShellSnapshot;
  butlerLive: ButlerLiveSnapshot;
  runtime: RuntimeSnapshot;
  openThreads: Record<string, CodexThreadDetailView>;
}

export interface PersistedUiState {
  threads?: CodexThreadDetailView[];
  windows: ButlerWindow[];
  focusedWindowId: string | null;
  stackLeases?: StackLeaseView[];
  previewLeases?: PreviewLeaseView[];
  serviceLeases?: ServiceLeaseView[];
  runtimeCleanupTasks?: RuntimeCleanupTaskView[];
  previewProofs?: PreviewProofRecordView[];
  workerReportsByThreadId?: Record<string, CodexWorkerReportView[]>;
  supervisionByThreadId?: Record<
    string,
    {
      butlerTurnsUsed?: number;
      maxButlerTurns?: number | null;
    }
  >;
  executionContractsByThreadId?: Record<string, CodexThreadExecutionContractView>;
  jobMemoriesByThreadId?: Record<string, JobMemoryView>;
  supervisionChecklistsByThreadId?: Record<string, SupervisionChecklistView>;
  projectMemoriesByProjectId?: Record<string, ProjectMemoryView>;
  butlerMemoryEntries?: ButlerMemoryEntryView[];
  projectArtifactsByProjectId?: Record<string, ProjectArtifactView[]>;
  projectPoliciesByProjectId?: Record<string, ProjectPolicyView[]>;
}
