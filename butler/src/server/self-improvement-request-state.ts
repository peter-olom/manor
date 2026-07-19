import crypto from "node:crypto";

import { readJsonStateFile, writeJsonStateFileAtomic } from "./json-state-file.js";
import type { SelfImprovementRequestStatus, SelfImprovementRequestView } from "../shared/self-improvement.js";

type PersistedState = { requests: SelfImprovementRequestView[] };
type RequestInput = {
  trigger?: unknown;
  symptoms?: unknown;
  logs?: unknown;
  observations?: unknown;
  suspectedCause?: unknown;
  proposedChange?: unknown;
  risk?: unknown;
  desiredOutcome?: unknown;
  operatorContext?: unknown;
  sourceThreadId?: unknown;
  sourceProjectLabel?: unknown;
  createdBy?: unknown;
};

let configuredState: SelfImprovementRequestState | null = null;

export type SelfImprovementCheckoutTransfer = {
  requestId: string;
  nextThreadId: string;
  previous: Pick<SelfImprovementRequestView, "status" | "threadId" | "workerThreadIds" | "startedAt" | "completedAt" | "commitSha" | "pullRequestUrl">;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function normalizeStatus(value: unknown): SelfImprovementRequestStatus {
  return value === "dismissed" ||
    value === "approved" ||
    value === "running" ||
    value === "changes_ready" ||
    value === "discarded" ||
    value === "committed" ||
    value === "pr_opened"
    ? value
    : "pending";
}

function ownsSourceCheckout(request: SelfImprovementRequestView): boolean {
  return request.status === "approved" ||
    request.status === "running" ||
    request.status === "changes_ready" ||
    request.status === "committed";
}

function normalizeRequest(raw: Partial<SelfImprovementRequestView> & { id?: string }): SelfImprovementRequestView | null {
  const trigger = text(raw.trigger);
  const symptoms = text(raw.symptoms);
  const observations = text(raw.observations);
  const suspectedCause = text(raw.suspectedCause);
  const proposedChange = text(raw.proposedChange);
  const risk = text(raw.risk);
  if (!raw.id || !trigger || !symptoms || !observations || !suspectedCause || !proposedChange || !risk) return null;
  const requestedAt = typeof raw.requestedAt === "number" && Number.isFinite(raw.requestedAt) ? raw.requestedAt : Date.now();
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : requestedAt;
  const threadId = nullableText(raw.threadId);
  const workerThreadIds = [...new Set([
    ...(Array.isArray(raw.workerThreadIds) ? raw.workerThreadIds.map(text).filter(Boolean) : []),
    ...(threadId ? [threadId] : [])
  ])];
  return {
    id: raw.id,
    status: normalizeStatus(raw.status),
    trigger,
    symptoms,
    logs: text(raw.logs),
    observations,
    suspectedCause,
    proposedChange,
    risk,
    desiredOutcome: nullableText(raw.desiredOutcome),
    operatorContext: nullableText(raw.operatorContext),
    sourceThreadId: nullableText(raw.sourceThreadId),
    sourceProjectLabel: nullableText(raw.sourceProjectLabel),
    createdBy: raw.createdBy === "operator" ? "operator" : "butler",
    requestedAt,
    updatedAt,
    dismissedAt: typeof raw.dismissedAt === "number" ? raw.dismissedAt : null,
    dismissedReason: nullableText(raw.dismissedReason),
    approvedAt: typeof raw.approvedAt === "number" ? raw.approvedAt : null,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
    threadId,
    workerThreadIds,
    pairId: nullableText(raw.pairId),
    workspaceCwd: nullableText(raw.workspaceCwd),
    branchName: nullableText(raw.branchName),
    commitSha: nullableText(raw.commitSha),
    pullRequestUrl: nullableText(raw.pullRequestUrl)
  };
}

export class SelfImprovementRequestState {
  private requests = new Map<string, SelfImprovementRequestView>();
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string, private readonly onChange: () => void, private readonly onError: (error: unknown) => void) {}

  async load(): Promise<void> {
    const loaded = await readJsonStateFile<PersistedState>(this.statePath, { requests: [] });
    this.requests.clear();
    for (const raw of loaded.requests) {
      const request = normalizeRequest(raw);
      if (request) this.requests.set(request.id, request);
    }
  }

  list(): SelfImprovementRequestView[] {
    return [...this.requests.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(id: string): SelfImprovementRequestView | null {
    return this.requests.get(id) ?? null;
  }

  hasSourceCheckoutOwner(excludingRequestId: string | null = null): boolean {
    return this.list().some((request) => request.id !== excludingRequestId && ownsSourceCheckout(request));
  }

  hasSourceCheckoutOwnerForOtherThread(threadId: string): boolean {
    return this.list().some((request) => ownsSourceCheckout(request) && request.threadId !== threadId);
  }

  hasOpenSourceRequest(sourceThreadId: string | null): boolean {
    if (!sourceThreadId) return false;
    return this.list().some((request) =>
      request.sourceThreadId === sourceThreadId &&
      !["dismissed", "discarded"].includes(request.status)
    );
  }

  create(input: RequestInput): SelfImprovementRequestView {
    const request = normalizeRequest({
      id: crypto.randomUUID(),
      status: "pending",
      trigger: text(input.trigger),
      symptoms: text(input.symptoms),
      logs: text(input.logs),
      observations: text(input.observations),
      suspectedCause: text(input.suspectedCause),
      proposedChange: text(input.proposedChange),
      risk: text(input.risk),
      desiredOutcome: nullableText(input.desiredOutcome),
      operatorContext: nullableText(input.operatorContext),
      sourceThreadId: nullableText(input.sourceThreadId),
      sourceProjectLabel: nullableText(input.sourceProjectLabel),
      createdBy: input.createdBy === "operator" ? "operator" : "butler",
      requestedAt: Date.now(),
      updatedAt: Date.now()
    });
    if (!request) throw new Error("Self-improvement requests require trigger, symptoms, observations, suspected cause, proposed change, and risk.");
    this.requests.set(request.id, request);
    this.persist();
    return request;
  }

  update(id: string, patch: Partial<SelfImprovementRequestView>): SelfImprovementRequestView {
    const current = this.requests.get(id);
    if (!current) throw new Error("Self-improvement request was not found.");
    const next = normalizeRequest({ ...current, ...patch, id, updatedAt: Date.now() });
    if (!next) throw new Error("Self-improvement request update would make the request invalid.");
    this.requests.set(id, next);
    this.persist();
    return next;
  }

  dismiss(id: string, reason: string | null): SelfImprovementRequestView {
    const now = Date.now();
    return this.update(id, { status: "dismissed", dismissedAt: now, dismissedReason: reason });
  }

  async remove(id: string): Promise<SelfImprovementRequestView> {
    const current = this.requests.get(id);
    if (!current) throw new Error("Self-improvement request was not found.");
    this.requests.delete(id);
    this.persist();
    try {
      await this.flush();
      return current;
    } catch (error) {
      this.requests.set(id, current);
      this.persist();
      try {
        await this.flush();
      } catch (rollbackError) {
        throw new Error(
          `Self-improvement request deletion failed and could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.saveQueue;
  }

  private persist(): void {
    const snapshot = { requests: this.list() };
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => writeJsonStateFileAtomic(this.statePath, snapshot))
      .then(() => this.onChange());
    void this.saveQueue.catch((error) => this.onError(error));
  }
}

export function configureSelfImprovementRequestState(state: SelfImprovementRequestState): void {
  configuredState = state;
}

export function getSelfImprovementRequestState(): SelfImprovementRequestState {
  if (!configuredState) throw new Error("Self-improvement request state is not configured.");
  return configuredState;
}

export function isSelfImprovementSourceCheckoutReserved(): boolean {
  return configuredState?.hasSourceCheckoutOwner() ?? false;
}

export function isSelfImprovementSourceCheckoutReservedByOtherThread(threadId: string): boolean {
  return configuredState?.hasSourceCheckoutOwnerForOtherThread(threadId) ?? false;
}

export function isClosedSelfImprovementWorkerThread(threadId: string): boolean {
  return configuredState?.list().some((request) => request.status === "discarded" && request.workerThreadIds.includes(threadId)) ?? false;
}

export function getSelfImprovementSourceCheckoutRequestId(threadId: string): string | null {
  return configuredState?.list().find((request) => ownsSourceCheckout(request) && request.threadId === threadId)?.id ?? null;
}

export function getSelfImprovementWorkerRequestId(threadId: string): string | null {
  return configuredState?.list().find((request) =>
    request.threadId === threadId &&
    ["approved", "running", "changes_ready", "committed", "pr_opened"].includes(request.status)
  )?.id ?? null;
}

export function isSelfImprovementSourceCheckoutOwnedByThread(threadId: string): boolean {
  const owners = configuredState?.list().filter(ownsSourceCheckout) ?? [];
  return owners.length === 1 && owners[0]?.threadId === threadId;
}

export async function transferSelfImprovementSourceCheckout(
  sourceThreadId: string,
  nextThreadId: string
): Promise<SelfImprovementCheckoutTransfer | null> {
  const requestId = getSelfImprovementSourceCheckoutRequestId(sourceThreadId);
  const request = requestId ? configuredState?.get(requestId) : null;
  if (!configuredState || !request) return null;
  const transfer: SelfImprovementCheckoutTransfer = {
    requestId: request.id,
    nextThreadId,
    previous: {
      status: request.status,
      threadId: request.threadId,
      workerThreadIds: [...request.workerThreadIds],
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      commitSha: request.commitSha,
      pullRequestUrl: request.pullRequestUrl
    }
  };
  configuredState.update(request.id, {
    status: "running",
    threadId: nextThreadId,
    startedAt: Date.now(),
    completedAt: null,
    commitSha: null,
    pullRequestUrl: null
  });
  try {
    await configuredState.flush();
    return transfer;
  } catch (error) {
    try {
      const current = configuredState.get(request.id);
      if (!current || current.threadId !== nextThreadId) {
        throw new Error("the checkout reservation changed before it could be restored");
      }
      configuredState.update(request.id, transfer.previous);
      await configuredState.flush();
    } catch (rollbackError) {
      throw new Error(
        `Self-improvement checkout transfer failed and rollback could not be persisted: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

export async function rollbackSelfImprovementSourceCheckout(transfer: SelfImprovementCheckoutTransfer): Promise<boolean> {
  if (!configuredState) return false;
  const current = configuredState.get(transfer.requestId);
  if (!current || current.threadId !== transfer.nextThreadId) return false;
  configuredState.update(transfer.requestId, transfer.previous);
  await configuredState.flush();
  return true;
}
