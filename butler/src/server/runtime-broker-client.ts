import type {
  PreviewBrowserMode,
  PreviewEgressProfile,
  PreviewLeaseStatus,
  PreviewVerificationView,
  ServiceLeaseStatus,
  StackLeaseStatus,
  StackStorageMode
} from "./types.js";

type LeasePayload = {
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
  bootstrap: {
    waitSeconds: number;
    hint: string | null;
    heartbeatKind: "none" | "http" | "tcp" | "command";
    heartbeatTarget: string | null;
    heartbeatIntervalSeconds: number;
    phase: "pulling_image" | "starting_container" | "bootstrapping" | "waiting_for_heartbeat" | "ready" | "failed";
    startedAt: number | null;
    readyAt: number | null;
    lastHeartbeatAt: number | null;
    lastHeartbeatError: string | null;
  };
};

type ServicePayload = {
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
  env: Record<string, string>;
};

type StackPayload = {
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
};

type ServiceInspectPayload = ServicePayload & {
  runtime: {
    running: boolean;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
  };
};

type LeaseInspectPayload = LeasePayload & {
  runtime: {
    running: boolean;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
  };
};

type LeaseProcessesPayload = {
  titles: string[];
  processes: string[][];
};

type LeaseLogsPayload = {
  leaseId: string;
  logs: string;
};

type LeaseExecPayload = {
  leaseId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ServiceListPayload = ServicePayload[];
type LeaseListPayload = LeasePayload[];
type StackListPayload = StackPayload[];
type BrowserSessionSummaryPayload = {
  sessionId: string;
  runId: string;
  mode: PreviewBrowserMode;
  targetUrl: string;
  title: string;
  url: string;
  status: number | null;
  resolution?: string;
  viewport?: { width: number; height: number };
  startedAt: number;
  actionCount: number;
};

type BrowserSessionStatePayload = {
  ok: true;
  session: {
    sessionId: string;
    runId: string;
    mode: PreviewBrowserMode;
    targetUrl: string;
    outputDir: string;
    startedAt: number;
    lastActivityAt: number;
    status: number | null;
    title: string;
    url: string;
    resolution?: string;
    viewport?: { width: number; height: number };
    actionCount: number;
    auth: {
      headerCount: number;
      cookieCount: number;
      cookieNames: string[];
      usedSessionCookie: boolean;
    };
  };
  tracked: {
    kind: "preview" | "browser";
    leaseId: string | null;
    threadId: string | null;
    projectId: string | null;
    projectLabel: string | null;
    title: string | null;
    runId: string;
    outputDir: string;
  } | null;
};

type BrowserSessionActionPayload = {
  ok: true;
  action: {
    type: string;
    durationMs: number;
  };
  state: {
    title: string;
    url: string;
    status: number | null;
    actionCount: number;
  };
};

type BrowserSessionStopPayload = {
  ok: true;
  verification: PreviewVerificationView;
  tracked: {
    kind: "preview" | "browser";
    leaseId: string | null;
    threadId: string | null;
    projectId: string | null;
    projectLabel: string | null;
    title: string | null;
    runId: string;
    outputDir: string;
  } | null;
  browserProof?: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
    targetUrl: string;
  };
};

type DesktopProofStatusPayload = {
  available: boolean;
  status: string;
  message: string;
  health: {
    ok: boolean;
    display: string;
    desktopHome?: string;
    xdgConfigHome?: string;
    vncUrl: string;
    activeSessionCount: number;
  } | null;
};

type DesktopSessionSummaryPayload = {
  sessionId: string;
  runId: string;
  mode: "headful";
  title: string;
  command: string;
  cwd: string;
  outputDir: string;
  startedAt: number;
  lastActivityAt: number;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  actionCount: number;
  vncUrl: string;
};

type DesktopSessionStatePayload = {
  ok: true;
  session: DesktopSessionSummaryPayload;
  tracked: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
    runId: string;
    outputDir: string;
  } | null;
};

type DesktopSessionActionPayload = {
  ok: true;
  action: {
    type: string;
    durationMs: number;
    output?: unknown;
  };
  state: DesktopSessionSummaryPayload;
};

type DesktopSessionStopPayload = {
  ok: true;
  verification: PreviewVerificationView;
  tracked: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
    runId: string;
    outputDir: string;
  } | null;
  desktopProof?: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
  };
};

export class RuntimeBrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null
  ) {}

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeMethod(method: string | undefined): string {
    return method?.trim().toUpperCase() || "GET";
  }

  private isIdempotentMethod(method: string): boolean {
    return ["GET", "HEAD", "OPTIONS"].includes(method);
  }

  private isRetryableFetchError(error: unknown, method: string): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const cause = error.cause as
      | {
          code?: string;
          hostname?: string;
        }
      | undefined;
    const brokerHostname = new URL(this.baseUrl).hostname;
    const code = typeof cause?.code === "string" ? cause.code : "";
    const hostname = typeof cause?.hostname === "string" ? cause.hostname : "";
    const idempotent = this.isIdempotentMethod(method);
    return (
      error.message === "fetch failed" &&
      (idempotent
        ? ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"].includes(code)
        : ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) &&
      (!hostname || hostname === brokerHostname)
    );
  }

  private formatRetryableFetchError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new Error(String(error));
    }

    const cause = error.cause as
      | {
          code?: string;
        }
      | undefined;
    const code = typeof cause?.code === "string" ? cause.code : "unavailable";
    return new Error(`Runtime broker is not ready yet (${code}). Retry shortly.`);
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const retryDelaysMs = [250, 500, 1000, 2000];
    let attempt = 0;
    const method = this.normalizeMethod(init?.method);

    while (true) {
      try {
        const response = await fetch(new URL(pathname, this.baseUrl), {
          ...init,
          headers: {
            "content-type": "application/json",
            ...(this.token ? { "x-manor-broker-token": this.token } : {}),
            ...(init?.headers ?? {})
          }
        });

        const payload = (await response.json()) as {
          error?: string;
          stage?: string;
          hint?: string | null;
          failureKind?: string;
        } & T;
        if (!response.ok) {
          const messageParts = [payload.error || `Runtime broker request failed with ${response.status}`];
          if (typeof payload.stage === "string" && payload.stage.trim()) {
            messageParts.push(`stage=${payload.stage.trim()}`);
          }
          if (typeof payload.hint === "string" && payload.hint.trim()) {
            messageParts.push(`hint=${payload.hint.trim()}`);
          }
          throw new Error(messageParts.join(" | "));
        }

        return payload;
      } catch (error) {
        if (!this.isRetryableFetchError(error, method)) {
          throw error;
        }
        if (attempt >= retryDelaysMs.length) {
          throw this.formatRetryableFetchError(error);
        }
        await this.sleep(retryDelaysMs[attempt] ?? 250);
        attempt += 1;
      }
    }
  }

  async createLease(input: {
    leaseId: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    stackId?: string | null;
    aliases?: string[];
    worktreePath: string;
    branchName: string | null;
    targetPort: number;
    command: string;
    workspaceMode?: "shared" | "snapshot";
    image?: string;
    egressProfile?: PreviewEgressProfile;
    egressDomains?: string[];
    bootstrapWaitSeconds?: number;
    bootstrapHint?: string;
    heartbeatKind?: "none" | "http" | "tcp" | "command";
    heartbeatTarget?: string;
    heartbeatIntervalSeconds?: number;
    env?: Record<string, string>;
  }): Promise<LeasePayload> {
    return this.request<LeasePayload>("/leases", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async stopLease(leaseId: string): Promise<{ ok: true; leaseId: string }> {
    return this.request<{ ok: true; leaseId: string }>(`/leases/${leaseId}`, {
      method: "DELETE"
    });
  }

  async inspectLease(leaseId: string): Promise<LeaseInspectPayload> {
    return this.request<LeaseInspectPayload>(`/leases/${leaseId}`);
  }

  async listLeases(threadId?: string | null): Promise<LeaseListPayload> {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    return this.request<LeaseListPayload>(`/leases${query}`);
  }

  async listProcesses(leaseId: string): Promise<LeaseProcessesPayload> {
    return this.request<LeaseProcessesPayload>(`/leases/${leaseId}/processes`);
  }

  async readLogs(leaseId: string, tail = 200): Promise<LeaseLogsPayload> {
    return this.request<LeaseLogsPayload>(`/leases/${leaseId}/logs?tail=${encodeURIComponent(String(tail))}`);
  }

  async execInLease(input: {
    leaseId: string;
    command: string;
    commandArgs?: string[];
    cwd?: string;
    stdin?: string;
    stdinProvided?: boolean;
  }): Promise<LeaseExecPayload> {
    return this.request<LeaseExecPayload>(`/leases/${input.leaseId}/exec`, {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        commandArgs: input.commandArgs,
        cwd: input.cwd,
        stdin: input.stdin,
        stdinProvided: input.stdinProvided === true
      })
    });
  }

  async startPreviewBrowserSession(input: {
    leaseId: string;
    mode?: PreviewBrowserMode;
    path?: string;
    targetUrl?: string;
    headers?: Record<string, string>;
    cookies?: Array<{ name: string; value: string }>;
    sessionCookie?: string;
    resolution?: string;
    waitForSelector?: string;
    postLoadWaitMs?: number;
  }): Promise<BrowserSessionSummaryPayload> {
    const payload = await this.request<{ ok: true; session: BrowserSessionSummaryPayload }>(`/leases/${input.leaseId}/browser-sessions`, {
      method: "POST",
      body: JSON.stringify({
        mode: input.mode === "headful" ? "headful" : "headless",
        path: input.path,
        targetUrl: input.targetUrl,
        headers: input.headers,
        cookies: input.cookies,
        sessionCookie: input.sessionCookie,
        resolution: input.resolution,
        waitForSelector: input.waitForSelector,
        postLoadWaitMs: input.postLoadWaitMs
      })
    });
    return payload.session;
  }

  async startBrowserSession(input: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
    targetUrl: string;
    mode?: PreviewBrowserMode;
    headers?: Record<string, string>;
    cookies?: Array<{ name: string; value: string }>;
    sessionCookie?: string;
    resolution?: string;
    waitForSelector?: string;
    postLoadWaitMs?: number;
  }): Promise<BrowserSessionSummaryPayload> {
    const payload = await this.request<{ ok: true; session: BrowserSessionSummaryPayload }>("/browser/sessions", {
      method: "POST",
      body: JSON.stringify({
        threadId: input.threadId,
        projectId: input.projectId,
        projectLabel: input.projectLabel,
        title: input.title,
        targetUrl: input.targetUrl,
        mode: input.mode === "headful" ? "headful" : "headless",
        headers: input.headers,
        cookies: input.cookies,
        sessionCookie: input.sessionCookie,
        resolution: input.resolution,
        waitForSelector: input.waitForSelector,
        postLoadWaitMs: input.postLoadWaitMs
      })
    });
    return payload.session;
  }

  async inspectBrowserSession(sessionId: string): Promise<BrowserSessionStatePayload> {
    return this.request<BrowserSessionStatePayload>(`/browser/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET"
    });
  }

  async runBrowserSessionAction(
    sessionId: string,
    input: {
      type: string;
      selector?: string;
      value?: string;
      values?: string[];
      text?: string;
      key?: string;
      url?: string;
      urlIncludes?: string;
      script?: string;
      ms?: number;
      x?: number;
      y?: number;
      delayMs?: number;
      timeoutMs?: number;
      label?: string;
      fileName?: string;
      autoCapture?: boolean;
    }
  ): Promise<BrowserSessionActionPayload> {
    return this.request<BrowserSessionActionPayload>(`/browser/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async stopBrowserSession(sessionId: string, reason?: string): Promise<BrowserSessionStopPayload> {
    return this.request<BrowserSessionStopPayload>(`/browser/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        reason: reason ?? "browser session stop"
      })
    });
  }

  async getDesktopProofStatus(): Promise<DesktopProofStatusPayload> {
    return this.request<DesktopProofStatusPayload>("/desktop/status");
  }

  async startDesktopSession(input: {
    threadId: string;
    projectId: string;
    projectLabel: string;
    title: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    waitMs?: number;
  }): Promise<DesktopSessionSummaryPayload> {
    const payload = await this.request<{ ok: true; session: DesktopSessionSummaryPayload }>("/desktop/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return payload.session;
  }

  async inspectDesktopSession(sessionId: string): Promise<DesktopSessionStatePayload> {
    return this.request<DesktopSessionStatePayload>(`/desktop/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET"
    });
  }

  async runDesktopSessionAction(
    sessionId: string,
    input: {
      type: string;
      label?: string;
      fileName?: string;
      ms?: number;
      x?: number;
      y?: number;
      toX?: number;
      toY?: number;
      button?: number;
      windowId?: string;
      key?: string;
      text?: string;
      delayMs?: number;
    }
  ): Promise<DesktopSessionActionPayload> {
    return this.request<DesktopSessionActionPayload>(`/desktop/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async stopDesktopSession(sessionId: string, reason?: string): Promise<DesktopSessionStopPayload> {
    return this.request<DesktopSessionStopPayload>(`/desktop/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        reason: reason ?? "desktop session stop"
      })
    });
  }

  async createService(input: {
    serviceId: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    stackId?: string | null;
    aliases?: string[];
    templateId: string;
    templateLabel: string;
    runtimeKind: "container" | "embedded";
    worktreePath?: string | null;
    targetPort: number;
    image: string;
    command?: string | null;
    workingDir?: string | null;
    stackVolumePath?: string | null;
    env?: Record<string, string>;
  }): Promise<ServicePayload> {
    return this.request<ServicePayload>("/services", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async createStack(input: {
    stackId: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    worktreePath?: string | null;
    storageMode?: StackStorageMode | null;
    retainsVolumes?: boolean;
    storageKey?: string | null;
    cloneFromStorageKey?: string | null;
  }): Promise<StackPayload> {
    return this.request<StackPayload>("/stacks", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async stopStack(stackId: string, options?: { dropVolumes?: boolean }): Promise<{ ok: true; stackId: string }> {
    const query = options?.dropVolumes ? "?dropVolumes=1" : "";
    return this.request<{ ok: true; stackId: string }>(`/stacks/${stackId}${query}`, {
      method: "DELETE"
    });
  }

  async inspectStack(stackId: string): Promise<StackPayload> {
    return this.request<StackPayload>(`/stacks/${stackId}`);
  }

  async adoptStack(input: {
    stackId: string;
    threadId: string;
  }): Promise<StackPayload> {
    return this.request<StackPayload>(`/stacks/${input.stackId}/adopt`, {
      method: "POST",
      body: JSON.stringify({
        threadId: input.threadId
      })
    });
  }

  async promoteStack(input: {
    stackId: string;
    targetStorageKey?: string | null;
  }): Promise<{
    ok: true;
    stackId: string;
    sourceStorageKey: string;
    targetStorageKey: string;
    promotedVolumes: string[];
  }> {
    return this.request<{
      ok: true;
      stackId: string;
      sourceStorageKey: string;
      targetStorageKey: string;
      promotedVolumes: string[];
    }>(`/stacks/${input.stackId}/promote`, {
      method: "POST",
      body: JSON.stringify({
        targetStorageKey: input.targetStorageKey ?? null
      })
    });
  }

  async listStacks(threadId?: string | null): Promise<StackListPayload> {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    return this.request<StackListPayload>(`/stacks${query}`);
  }

  async stopService(serviceId: string): Promise<{ ok: true; serviceId: string }> {
    return this.request<{ ok: true; serviceId: string }>(`/services/${serviceId}`, {
      method: "DELETE"
    });
  }

  async inspectService(serviceId: string): Promise<ServiceInspectPayload> {
    return this.request<ServiceInspectPayload>(`/services/${serviceId}`);
  }

  async listServices(threadId?: string | null): Promise<ServiceListPayload> {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    return this.request<ServiceListPayload>(`/services${query}`);
  }

  async listServiceProcesses(serviceId: string): Promise<LeaseProcessesPayload> {
    return this.request<LeaseProcessesPayload>(`/services/${serviceId}/processes`);
  }

  async readServiceLogs(serviceId: string, tail = 200): Promise<LeaseLogsPayload> {
    return this.request<LeaseLogsPayload>(`/services/${serviceId}/logs?tail=${encodeURIComponent(String(tail))}`);
  }

  async execInService(input: {
    serviceId: string;
    command: string;
    commandArgs?: string[];
    cwd?: string;
    stdin?: string;
    stdinProvided?: boolean;
  }): Promise<LeaseExecPayload> {
    return this.request<LeaseExecPayload>(`/services/${input.serviceId}/exec`, {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        commandArgs: input.commandArgs,
        cwd: input.cwd,
        stdin: input.stdin,
        stdinProvided: input.stdinProvided === true
      })
    });
  }
}
