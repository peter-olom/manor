import { promises as fs } from "node:fs";

import type { HostControllerClient, ManorRestartRun, ManorRestartStartResult } from "./host-controller-client.js";
import {
  authorizeManorRestartRequest,
  buildAuthorizedManorRestartInput,
  createManorRestartRequest,
  isManorRestartRequestWithStatus,
  requireAuthorizedManorRestartRequest,
  requirePendingManorRestartRequest
} from "./manor-restart-authorization.js";
import type { ManorRestartRequestView } from "./types.js";
import type { ManorRestartProgressView, ManorRestartTrackingView } from "../shared/manor-restart.js";

type RestartRequestInput = {
  target?: unknown;
  gitRef?: unknown;
  includeDesktop?: unknown;
  build?: unknown;
  update?: unknown;
  reason?: unknown;
  details?: unknown;
};

type RestartRequestStateSnapshot = {
  pendingManorRestartRequest: ManorRestartRequestView | null;
  authorizedManorRestartRequest: ManorRestartRequestView | null;
  trackedManorRestart: ManorRestartTrackingView | null;
};

export class ManorRestartRequestState {
  private pending: ManorRestartRequestView | null = null;
  private authorized: ManorRestartRequestView | null = null;
  private tracked: ManorRestartTrackingView | null = null;
  private startingRequestId: string | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly hostController: HostControllerClient,
    private readonly onError: (error: unknown) => void,
    private readonly onChange: () => void
  ) {}

  get pendingRequest(): ManorRestartRequestView | null {
    return this.pending;
  }

  get authorizedRequest(): ManorRestartRequestView | null {
    return this.authorized;
  }

  get trackedRestart(): ManorRestartTrackingView | null {
    return this.tracked;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8")) as {
        pendingManorRestartRequest?: unknown;
        authorizedManorRestartRequest?: unknown;
        trackedManorRestart?: unknown;
      };
      this.pending = isManorRestartRequestWithStatus(parsed.pendingManorRestartRequest, "pending")
        ? parsed.pendingManorRestartRequest
        : null;
      this.authorized = isManorRestartRequestWithStatus(parsed.authorizedManorRestartRequest, "authorized")
        ? parsed.authorizedManorRestartRequest
        : null;
      this.tracked = readTrackedRestart(parsed.trackedManorRestart);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  request(input: RestartRequestInput): ManorRestartRequestView {
    if (this.startingRequestId) {
      throw new Error("A Manor restart is already starting.");
    }
    this.pending = createManorRestartRequest(input);
    this.authorized = null;
    void this.persist();
    this.onChange();
    return this.pending;
  }

  authorize(requestId: string): ManorRestartRequestView {
    const authorizedRequest = authorizeManorRestartRequest(this.pending, requestId);
    this.pending = null;
    this.authorized = authorizedRequest;
    void this.persist();
    this.onChange();
    return authorizedRequest;
  }

  dismiss(requestId: string): void {
    requirePendingManorRestartRequest(this.pending, requestId, "dismissal");
    this.pending = null;
    void this.persist();
    this.onChange();
  }

  async start(requestId: string): Promise<{ restartRequest: ManorRestartRequestView; run: ManorRestartRun }> {
    if (this.startingRequestId) {
      throw new Error("A Manor restart is already starting.");
    }
    const restartRequest = requireAuthorizedManorRestartRequest(this.authorized, requestId);
    this.startingRequestId = requestId;
    let result: ManorRestartStartResult;
    try {
      result = await this.hostController.restart(buildAuthorizedManorRestartInput(restartRequest));
    } catch (error) {
      this.pending = { ...restartRequest, status: "pending", authorizedAt: null };
      this.authorized = null;
      await this.persist();
      this.onChange();
      throw error;
    } finally {
      this.startingRequestId = null;
    }
    this.authorized = null;
    this.tracked = {
      requestId: restartRequest.id,
      runId: result.run.id,
      startedAt: result.run.startedAt
    };
    await this.persist(true);
    this.onChange();
    return { restartRequest, run: result.run };
  }

  async getProgress(): Promise<ManorRestartProgressView | null> {
    const tracked = this.tracked;
    if (!tracked) return null;
    const status = await this.hostController.getStatus();
    const run = [status.active, status.latestRun].find((candidate) => candidate?.id === tracked.runId) ?? null;
    if (!run) {
      return { ...tracked, status: "unconfirmed", completedAt: null, currentStep: null, error: null };
    }
    const currentStep = run.steps.find((step) => step.status === "running")
      ?? [...run.steps].reverse().find((step) => step.status === "failed")
      ?? [...run.steps].reverse().find((step) => step.status === "completed")
      ?? null;
    return {
      ...tracked,
      status: run.status,
      completedAt: run.completedAt,
      currentStep: currentStep?.label ?? null,
      error: run.status === "failed" ? "The host controller could not complete the restart." : null
    };
  }

  async acknowledgeProgress(requestId: string): Promise<boolean> {
    if (this.tracked?.requestId !== requestId) return false;
    const tracked = this.tracked;
    this.tracked = null;
    try {
      await this.persist(true);
    } catch (error) {
      if (this.tracked === null) this.tracked = tracked;
      throw error;
    }
    this.onChange();
    return true;
  }

  private persist(required = false): Promise<void> {
    const snapshot = {
      pendingManorRestartRequest: this.pending,
      authorizedManorRestartRequest: this.authorized,
      trackedManorRestart: this.tracked
    };
    const write = this.saveQueue
      .catch(() => undefined)
      .then(() => this.save(snapshot));
    this.saveQueue = write.catch((error) => {
      this.onError(error);
    });
    return required ? write : this.saveQueue;
  }

  private async save(snapshot: RestartRequestStateSnapshot): Promise<void> {
    await fs.writeFile(
      this.statePath,
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  }
}

function readTrackedRestart(value: unknown): ManorRestartTrackingView | null {
  if (!value || typeof value !== "object") return null;
  const tracked = value as Partial<ManorRestartTrackingView>;
  if (typeof tracked.requestId !== "string" || !tracked.requestId) return null;
  if (typeof tracked.runId !== "string" || !tracked.runId) return null;
  if (typeof tracked.startedAt !== "number" || !Number.isFinite(tracked.startedAt)) return null;
  return { requestId: tracked.requestId, runId: tracked.runId, startedAt: tracked.startedAt };
}
