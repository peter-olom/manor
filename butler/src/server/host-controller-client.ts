export type ManorRestartMode = "auto" | "source" | "image";
export type ManorRestartTarget = "current" | "latest";

export interface ManorRestartRunStep {
  label: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

export interface ManorRestartRun {
  id: string;
  status: "running" | "completed" | "failed";
  mode: "source" | "image";
  target: ManorRestartTarget | string;
  gitRef: string | null;
  imageTag: string | null;
  includeDesktop: boolean;
  update: boolean;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  steps: ManorRestartRunStep[];
}

export interface ManorRestartStatus {
  ok: true;
  active: ManorRestartRun | null;
  latestRun: ManorRestartRun | null;
  detectedMode: "source" | "image";
}

export interface ManorRestartStartResult {
  ok: true;
  run: ManorRestartRun;
}

export class HostControllerClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly token: string | null
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    if (!this.baseUrl || !this.token) {
      throw new Error("Manor host controller is not configured.");
    }

    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-manor-host-controller-token": this.token,
        ...(init?.headers ?? {})
      }
    });
    const payload = (await response.json()) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(payload.error || `Host controller request failed with ${response.status}`);
    }
    return payload;
  }

  getStatus(): Promise<ManorRestartStatus> {
    return this.request<ManorRestartStatus>("/status");
  }

  restart(input: {
    mode?: ManorRestartMode;
    target?: ManorRestartTarget;
    gitRef?: string | null;
    imageTag?: string | null;
    includeDesktop?: boolean;
    build?: boolean;
    update?: boolean;
    confirmation: "restart Manor";
  }): Promise<ManorRestartStartResult> {
    return this.request<ManorRestartStartResult>("/restart", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
}
