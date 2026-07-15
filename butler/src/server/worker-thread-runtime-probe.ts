export type WorkerThreadRuntimeProbe = {
  state: "busy" | "idle";
  busy: boolean;
  compacting: boolean;
  pendingMessageCount: number;
  activityAt: number | null;
  acknowledgedWait: string | null;
  confirmedDead: false;
};

export type WorkerThreadProbeResult = (WorkerThreadRuntimeProbe & { attemptId: string }) | {
  attemptId: string;
  state: "unreachable";
  busy: false;
  compacting: false;
  pendingMessageCount: 0;
  activityAt: number | null;
  detail: string | null;
  acknowledgedWait: null;
  confirmedDead: boolean;
};

export type WorkerThreadInterventionResult = {
  state: "stopped" | "idle" | "failed" | "timeout";
  detail: string | null;
};

export class WorkerTransportDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTransportDeadError";
  }
}
