import { promises as fs } from "node:fs";

import type { HostControllerClient, ManorRestartRun } from "./host-controller-client.js";
import {
  authorizeManorRestartRequest,
  buildAuthorizedManorRestartInput,
  createManorRestartRequest,
  isManorRestartRequestWithStatus,
  requireAuthorizedManorRestartRequest,
  requirePendingManorRestartRequest
} from "./manor-restart-authorization.js";
import type { ManorRestartRequestView } from "./types.js";

type RestartRequestInput = {
  mode?: unknown;
  target?: unknown;
  gitRef?: unknown;
  imageTag?: unknown;
  targetCommit?: unknown;
  targetTag?: unknown;
  includeDesktop?: unknown;
  build?: unknown;
  update?: unknown;
  reason?: unknown;
  details?: unknown;
};

type RestartRequestStateSnapshot = {
  pendingManorRestartRequest: ManorRestartRequestView | null;
  authorizedManorRestartRequest: ManorRestartRequestView | null;
};

export class ManorRestartRequestState {
  private pending: ManorRestartRequestView | null = null;
  private authorized: ManorRestartRequestView | null = null;
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

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8")) as {
        pendingManorRestartRequest?: unknown;
        authorizedManorRestartRequest?: unknown;
      };
      this.pending = isManorRestartRequestWithStatus(parsed.pendingManorRestartRequest, "pending")
        ? parsed.pendingManorRestartRequest
        : null;
      this.authorized = isManorRestartRequestWithStatus(parsed.authorizedManorRestartRequest, "authorized")
        ? parsed.authorizedManorRestartRequest
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  request(input: RestartRequestInput): ManorRestartRequestView {
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
    const restartRequest = requireAuthorizedManorRestartRequest(this.authorized, requestId);
    const result = await this.hostController.restart(buildAuthorizedManorRestartInput(restartRequest));
    this.authorized = null;
    await this.persist();
    this.onChange();
    return { restartRequest, run: result.run };
  }

  private persist(): Promise<void> {
    const snapshot = {
      pendingManorRestartRequest: this.pending,
      authorizedManorRestartRequest: this.authorized
    };
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => this.save(snapshot))
      .catch((error) => {
        this.onError(error);
      });
    return this.saveQueue;
  }

  private async save(snapshot: RestartRequestStateSnapshot): Promise<void> {
    await fs.writeFile(
      this.statePath,
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  }
}
