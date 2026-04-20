export type ThreadStatus = "active" | "idle" | "unknown";
export type ButlerCallbackState =
  | "waiting"
  | "received_worker_callback"
  | "missing_worker_callback"
  | "recovered_from_thread_state"
  | "closed";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ButlerThinkingLevel = "off" | ReasoningEffort;
export type ThemePreference = "system" | "light" | "dark";
export type OnboardingCommandTarget = "localShell" | "butlerTerminal" | "codexTerminal";
export type SetupCommandMode = "localShell" | "builtInTerminal";
export type TerminalTarget = "butlerTerminal" | "codexTerminal";
export type WorkspaceSurface = "setup" | "butler" | "terminal" | "thread";
export type ToastTone = "success" | "error" | "info";

export type ButlerMessageRecord = {
  id: string;
  role: string;
  text: string;
  at: number | null;
  kind: "message";
};

export type ButlerHistoryPageResponse = {
  messages: ButlerMessageRecord[];
  startIndex: number;
  endIndex: number;
  totalCount: number;
  hasMore: boolean;
};

export type ButlerHistoryState = {
  messages: ButlerMessageRecord[];
  loadedStart: number;
  totalCount: number;
};

export type AppToast = {
  key: string;
  message: string;
  tone: ToastTone;
};

export type ServerToastEvent = {
  id: string;
  message: string;
  tone: ToastTone;
  duration: number;
};

export type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel: string;
  tone: "danger";
  onConfirm: () => Promise<void>;
};

export type PendingThreadRequest = {
  threadId: string;
  text: string;
  sentAt: number;
  attachmentCount: number;
};

export type ImageReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
};

export type FileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
};

export type PreviewableImage = {
  id: string;
  name: string;
  url: string;
};

export type PreviewableFile = {
  id: string;
  name: string;
  url: string;
};

export type PreviewMedia = {
  name: string;
  url: string;
  kind: "image" | "video";
  downloadUrl: string | null;
};

export type PreviewVerificationArtifact = {
  kind: "manifest" | "screenshot" | "video" | "trace" | "html" | "other";
  label: string;
  fileName: string;
  filePath: string;
  contentType: string;
  sizeBytes: number | null;
  url: string | null;
  downloadUrl: string | null;
  availability: "available" | "expired" | "missing";
  retainedUntilAt: number | null;
  expiredAt: number | null;
};

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

export type PreviewVerification = {
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
  summary: {
    consoleMessageCount: number;
    pageErrorCount: number;
    failedRequestCount: number;
    responseErrorCount: number;
    assetFailureCount: number;
    phaseCount: number;
  };
  phases: Array<{
    name: string;
    label: string;
    status: "completed" | "failed" | "skipped";
    startedAt: number;
    completedAt: number;
    durationMs: number;
    message: string | null;
  }>;
  readiness: {
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
  };
  auth: {
    headerCount: number;
    cookieCount: number;
    cookieNames: string[];
    usedSessionCookie: boolean;
  };
  diagnostics?: {
    stages: {
      processUp: {
        name: string;
        ok: boolean | null;
        detail: string;
        status: number | null;
        hint: string | null;
        failureKind: PreviewVerificationFailureKind | null;
      } | null;
      networkReachable: {
        name: string;
        ok: boolean | null;
        detail: string;
        status: number | null;
        hint: string | null;
        failureKind: PreviewVerificationFailureKind | null;
      } | null;
      routeAuth: {
        name: string;
        ok: boolean | null;
        detail: string;
        status: number | null;
        hint: string | null;
        failureKind: PreviewVerificationFailureKind | null;
      } | null;
      uiSelectorVisible: {
        name: string;
        ok: boolean | null;
        detail: string;
        status: number | null;
        hint: string | null;
        failureKind: PreviewVerificationFailureKind | null;
      } | null;
    };
    remediationHints: string[];
  };
  artifacts: PreviewVerificationArtifact[];
  consoleMessages: Array<{
    type: string;
    text: string;
    location: string | null;
  }>;
  pageErrors: string[];
  failedRequests: Array<{
    url: string;
    method: string;
    errorText: string | null;
  }>;
};

export type PreviewProofRecord = {
  id: string;
  previewId: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  previewTitle: string;
  stackId: string | null;
  verification: PreviewVerification;
  createdAt: number;
  updatedAt: number;
};

export type ModelOption = {
  id: string;
  label: string;
  provider: string | null;
  supportsReasoning: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | null;
};

export type CodexThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  source: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  turnCount: number;
  loaded: boolean;
  contextUsage: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
  };
  supervision: {
    butlerTurnsUsed: number;
    maxButlerTurns: number | null;
    capReached: boolean;
  };
  compaction: {
    active: boolean;
    count: number;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
  };
  supervisor: {
    projectId: string;
    projectLabel: string;
    latestUserPrompt: string | null;
    latestAgentReply: string | null;
    summary: string;
    blocked: boolean;
  };
  executionContract: {
    threadId: string;
    workspaceCwd: string | null;
    projectId: string;
    projectLabel: string;
    branch: string | null;
    executionLane: "codex-shell" | "preview-runtime";
    executionLaneLabel: string;
    proofMode: "none" | "operational" | "ui";
    proofModeLabel: string;
    requestedTask: string;
    operatorGoal: string | null;
    successConditions: string[];
    stopConditions: string[];
    escalationConditions: string[];
    notes: string[];
  } | null;
};

export type CodexThreadDetail = CodexThreadSummary & {
  turns: Array<{
    id: string;
    status: string;
    error: string | null;
    startedAt: number;
    completedAt: number | null;
    items: Array<{
      id: string;
      type: string;
      status: string;
      text: string;
      at: number;
    }>;
  }>;
  eventLog: Array<{
    at: number;
    method: string;
    summary: string;
  }>;
  workerReport: {
    threadId: string;
    turnId: string;
    status: "completed" | "blocked";
    summary: string;
    details: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
};

export type ButlerThreadCallback = {
  threadId: string;
  callbackState: ButlerCallbackState;
  resolutionState: "received_worker_callback" | "recovered_from_thread_state" | null;
  requestedAt: number;
  lastEventAt: number | null;
  lastWorkerStatusSeen: ThreadStatus | null;
  lastTerminalReportAt: number | null;
  lastPrivateSteerText: string | null;
  lastPrivateSteerAt: number | null;
  nextWorkerReportAction: "review" | "reply_to_operator";
  operatorCloseoutStatus: "not_required" | "owed" | "posted";
  owesOperatorReply: boolean;
  closeoutChannel: "none" | "main_chat";
  reviewState: "idle" | "queued" | "running";
  reviewReason: "worker_callback" | "thread_recovery" | null;
  closedAt: number | null;
  updatedAt: number;
};

export type ButlerWindowRecord = {
  threadId: string;
  title: string;
  openedAt: number;
};

export type RuntimeSnapshot = {
  latestPreviewProofsByThreadId: Record<string, PreviewProofRecord>;
  previewProofsByThreadId: Record<string, PreviewProofRecord[]>;
  stacks: Array<{
    id: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    networkName: string;
    mode: string;
    storageMode: string;
    storageKey: string | null;
    baseStorageKey: string | null;
    forkedFromStorageKey: string | null;
    stickyVolumeCount: number;
    previewIds: string[];
    serviceIds: string[];
    status: string;
    createdAt: number;
    updatedAt: number;
    pinned?: boolean;
    expiresAt?: number | null;
    lifecycleState?: string;
  }>;
  previews: Array<{
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
    routePrefix: string;
    operatorUrl: string;
    command: string;
    workspaceMode: "shared" | "snapshot";
    image: string;
    egressProfile: string;
    egressDomains: string[];
    status: string;
    createdAt: number;
    updatedAt: number;
    lastError: string | null;
    pinned?: boolean;
    expiresAt?: number | null;
    lifecycleState?: string;
    lastVerification?: PreviewVerification | null;
    bootstrap: {
      waitSeconds: number;
      hint: string | null;
      heartbeatKind: string;
      heartbeatTarget: string | null;
      heartbeatIntervalSeconds: number;
      phase: string;
      startedAt: number | null;
      readyAt: number | null;
      lastHeartbeatAt: number | null;
      lastHeartbeatError: string | null;
    };
  }>;
  serviceTemplates: Array<{
    id: string;
    label: string;
    description: string;
    runtimeKind: "container" | "embedded";
    engine: string;
    image: string;
    defaultPort: number;
    stackVolumePath: string | null;
    notes: string | null;
  }>;
  services: Array<{
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
    status: string;
    createdAt: number;
    updatedAt: number;
    lastError: string | null;
    pinned?: boolean;
    expiresAt?: number | null;
    lifecycleState?: string;
    connection: {
      engine: string;
      host: string;
      port: number;
      database: string | null;
      username: string | null;
      password: string | null;
      uri: string | null;
      notes: string | null;
    };
    storageKind: string;
    volumeName: string | null;
  }>;
};

export type ShellSnapshot = {
  codex: {
    connected: boolean;
    lastError: string | null;
    auth: {
      mode: "chatgpt" | "api" | "none" | "unknown";
      loggedIn: boolean;
      validationError: string | null;
      lastValidatedAt: number | null;
    };
    threads: CodexThreadSummary[];
    windows: ButlerWindowRecord[];
    focusedWindowId: string | null;
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
    auth: {
      mode: "chatgpt" | "api" | "none" | "unknown";
      loggedIn: boolean;
      validationError: string | null;
      lastValidatedAt: number | null;
    };
    tools: Array<{
      name: string;
      label: string;
      description: string;
      uiEffects: Array<{
        kind: "refreshThreads" | "refreshThread" | "openWindow" | "focusWindow" | "removeThread" | "removeThreads" | "focusButler";
        description: string;
      }>;
    }>;
    onboarding: {
      complete: boolean;
      steps: Array<{
        id: "butlerAuth" | "codexAuth" | "githubAuth";
        title: string;
        status: "complete" | "pending";
        detail: string;
        commandSets: Array<{
          target: OnboardingCommandTarget;
          detail: string;
          commands: string[];
        }>;
      }>;
    };
    contextUsage: {
      tokens: number | null;
      contextWindow: number | null;
      percent: number | null;
    };
    compaction: {
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
    };
    supervision: {
      projects: Array<{
        id: string;
        label: string;
        threadCount: number;
        activeCount: number;
        blockedCount: number;
        completedCount: number;
        updatedAt: number;
        summary: string;
        threadIds: string[];
      }>;
      supervisor: {
        totalThreads: number;
        activeThreads: number;
        blockedThreads: number;
        completedThreads: number;
        projectCount: number;
        updatedAt: number;
        summary: string;
      };
      callbacks: ButlerThreadCallback[];
    };
    lastError: string | null;
    compose: {
      provider: string | null;
      model: string | null;
      thinkingLevel: ButlerThinkingLevel;
      availableThinkingLevels: ButlerThinkingLevel[];
      availableModels: ModelOption[];
    };
  };
};

export type ButlerLiveSnapshot = {
  messages: ButlerMessageRecord[];
  messageCount: number;
};

export type BootstrapSnapshot = {
  shell: ShellSnapshot;
  butlerLive: ButlerLiveSnapshot;
  runtime: RuntimeSnapshot;
  openThreads: Record<string, CodexThreadDetail>;
};

export type TransportState = {
  connected: boolean;
  disconnected: boolean;
  reconnecting: boolean;
  lastEventAt: number | null;
  lastError: string | null;
};
