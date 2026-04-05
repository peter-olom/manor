import type { PreviewEgressProfile, PreviewLeaseStatus } from "./types.js";

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

export class RuntimeBrokerClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
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
}
