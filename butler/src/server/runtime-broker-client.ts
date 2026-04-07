import type { PreviewBrowserMode, PreviewEgressProfile, PreviewLeaseStatus, PreviewVerificationView, ServiceLeaseStatus } from "./types.js";

type LeasePayload = {
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
  env: Record<string, string>;
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

export class RuntimeBrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null
  ) {}

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { "x-manor-broker-token": this.token } : {}),
        ...(init?.headers ?? {})
      }
    });

    const payload = (await response.json()) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(payload.error || `Runtime broker request failed with ${response.status}`);
    }

    return payload;
  }

  async createLease(input: {
    leaseId: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    worktreePath: string;
    branchName: string | null;
    targetPort: number;
    command: string;
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
    cwd?: string;
  }): Promise<LeaseExecPayload> {
    return this.request<LeaseExecPayload>(`/leases/${input.leaseId}/exec`, {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        cwd: input.cwd
      })
    });
  }

  async verifyLease(input: {
    leaseId: string;
    mode?: PreviewBrowserMode;
  }): Promise<PreviewVerificationView> {
    return this.request(`/leases/${input.leaseId}/verify`, {
      method: "POST",
      body: JSON.stringify({
        mode: input.mode === "headful" ? "headful" : "headless"
      })
    });
  }

  async createService(input: {
    serviceId: string;
    threadId: string | null;
    projectId: string;
    projectLabel: string;
    title: string;
    templateId: string;
    templateLabel: string;
    runtimeKind: "container" | "embedded";
    worktreePath?: string | null;
    targetPort: number;
    image: string;
    command?: string | null;
    env?: Record<string, string>;
  }): Promise<ServicePayload> {
    return this.request<ServicePayload>("/services", {
      method: "POST",
      body: JSON.stringify(input)
    });
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
    cwd?: string;
  }): Promise<LeaseExecPayload> {
    return this.request<LeaseExecPayload>(`/services/${input.serviceId}/exec`, {
      method: "POST",
      body: JSON.stringify({
        command: input.command,
        cwd: input.cwd
      })
    });
  }
}
