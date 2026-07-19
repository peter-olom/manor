import crypto from "node:crypto";

import type { ActivityWatchdogService } from "./activity-watchdog.js";
import type { PiRpcWorkerClient, PiWorkerCompactionEvent } from "./pi-rpc-worker-client.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import type { WorkerCompactionOperation } from "../shared/worker-session-controls.js";

const WORKER_COMPACTION_DEADLINE_MS = 10 * 60_000;

type SupervisedCompaction = WorkerCompactionOperation & {
  lastProbeError: string | null;
  probeFailures: number;
};

type CompactionClient = Pick<PiRpcWorkerClient, "compactThread" | "probeThread">;
type CompactionWatchdogs = Pick<ActivityWatchdogService, "register" | "unregister">;

function publicOperation(operation: SupervisedCompaction | null): WorkerCompactionOperation | null {
  if (!operation) return null;
  return {
    id: operation.id,
    status: operation.status,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    error: operation.error
  };
}

function isActive(operation: SupervisedCompaction): boolean {
  return operation.status === "starting" || operation.status === "running";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).replace(/\s+/g, " ").trim().slice(0, 500) || "Worker context compaction failed.";
}

function ambiguousDispatchFailure(message: string): boolean {
  return /timeout waiting for response to compact|transport|connection|closed|unavailable|econn|epipe/i.test(message);
}

export class WorkerCompactionSupervisor {
  private readonly operations = new Map<string, SupervisedCompaction>();
  private readonly checksInFlight = new Set<string>();

  constructor(private readonly options: {
    client: CompactionClient;
    watchdogs: CompactionWatchdogs;
    now?: () => number;
    deadlineMs?: number;
    onChange?: () => void;
  }) {}

  get(threadId: string): WorkerCompactionOperation | null {
    return publicOperation(this.operations.get(threadId) ?? null);
  }

  async start(threadId: string, instructions: string): Promise<WorkerCompactionOperation> {
    const existing = this.operations.get(threadId);
    if (existing && isActive(existing)) throw new Error("Worker context compaction is already in progress.");

    const operation: SupervisedCompaction = {
      id: crypto.randomUUID(),
      status: "starting",
      startedAt: this.now(),
      completedAt: null,
      error: null,
      lastProbeError: null,
      probeFailures: 0
    };
    this.operations.set(threadId, operation);
    let probe;
    try {
      probe = await this.options.client.probeThread(threadId);
    } catch (error) {
      if (this.isCurrent(threadId, operation.id)) this.operations.delete(threadId);
      throw error;
    }
    if (probe.busy || probe.compacting) {
      if (this.isCurrent(threadId, operation.id)) this.operations.delete(threadId);
      throw new Error("Wait for the current Worker operation to finish before compacting.");
    }

    this.register(threadId);
    this.options.onChange?.();

    void this.options.client.compactThread(threadId, instructions).then(
      () => this.complete(threadId, operation.id),
      (error) => { void this.handleDispatchFailure(threadId, operation.id, error); }
    );
    return publicOperation(operation)!;
  }

  handleRuntimeEvent(event: PiWorkerCompactionEvent): void {
    const operation = this.operations.get(event.threadId);
    if (!operation || !isActive(operation)) return;
    if (event.status === "started") {
      if (operation.status !== "running") {
        operation.status = "running";
        this.options.onChange?.();
      }
      return;
    }
    if (event.status === "completed") this.complete(event.threadId, operation.id);
    else this.fail(event.threadId, operation.id, safeError(event.error ?? "Worker context compaction failed."));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private registrationId(threadId: string): string {
    return `worker-compaction:${threadId}`;
  }

  private register(threadId: string): void {
    this.options.watchdogs.unregister(this.registrationId(threadId));
    this.options.watchdogs.register({
      id: this.registrationId(threadId),
      policy: "worker-compaction",
      target: threadId,
      callback: () => { void this.check(threadId); }
    });
  }

  private async check(threadId: string): Promise<void> {
    if (this.checksInFlight.has(threadId)) return;
    const operation = this.operations.get(threadId);
    if (!operation || !isActive(operation)) return;
    this.checksInFlight.add(threadId);
    try {
      const probe = await this.options.client.probeThread(threadId);
      if (!this.isCurrent(threadId, operation.id)) return;
      operation.lastProbeError = null;
      operation.probeFailures = 0;
      if (probe.compacting) {
        if (operation.status !== "running") {
          operation.status = "running";
          this.options.onChange?.();
        }
        return;
      }
      if (this.deadlineReached(operation)) {
        this.fail(threadId, operation.id, "Worker context compaction ended without a completion result.");
      }
    } catch (error) {
      if (!this.isCurrent(threadId, operation.id)) return;
      operation.lastProbeError = safeError(error);
      operation.probeFailures += 1;
      if (this.deadlineReached(operation) && operation.probeFailures >= 3) {
        this.fail(threadId, operation.id, `Worker context compaction became unreachable. Last probe: ${operation.lastProbeError}`);
      }
    } finally {
      this.checksInFlight.delete(threadId);
    }
  }

  private async handleDispatchFailure(threadId: string, operationId: string, error: unknown): Promise<void> {
    const message = safeError(error);
    if (!this.isCurrent(threadId, operationId)) return;
    try {
      const probe = await this.options.client.probeThread(threadId);
      if (!this.isCurrent(threadId, operationId)) return;
      if (probe.compacting) {
        const operation = this.operations.get(threadId)!;
        operation.status = "running";
        operation.lastProbeError = message;
        this.options.onChange?.();
        return;
      }
      if (ambiguousDispatchFailure(message)) {
        const operation = this.operations.get(threadId);
        if (operation?.id === operationId) operation.lastProbeError = message;
        return;
      }
    } catch {
      // The watchdog owns recovery when dispatch may have reached Pi.
      const operation = this.operations.get(threadId);
      if (operation?.id === operationId) operation.lastProbeError = message;
      return;
    }
    this.fail(threadId, operationId, message);
  }

  private deadlineReached(operation: SupervisedCompaction): boolean {
    return this.now() - operation.startedAt >= (this.options.deadlineMs ?? WORKER_COMPACTION_DEADLINE_MS);
  }

  private isCurrent(threadId: string, operationId: string): boolean {
    return this.operations.get(threadId)?.id === operationId;
  }

  private complete(threadId: string, operationId: string): void {
    const operation = this.operations.get(threadId);
    if (!operation || operation.id !== operationId || !isActive(operation)) return;
    operation.status = "completed";
    operation.completedAt = this.now();
    operation.error = null;
    this.options.watchdogs.unregister(this.registrationId(threadId));
    this.options.onChange?.();
  }

  private fail(threadId: string, operationId: string, message: string): void {
    const operation = this.operations.get(threadId);
    if (!operation || operation.id !== operationId || !isActive(operation)) return;
    operation.status = "failed";
    operation.completedAt = this.now();
    operation.error = message;
    this.options.watchdogs.unregister(this.registrationId(threadId));
    this.options.onChange?.();
  }
}
