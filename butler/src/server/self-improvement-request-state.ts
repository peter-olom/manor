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
  sourceThreadId?: unknown;
  sourceProjectLabel?: unknown;
  createdBy?: unknown;
};

let configuredState: SelfImprovementRequestState | null = null;

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
    threadId: nullableText(raw.threadId),
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

  private persist(): void {
    const snapshot = { requests: this.list() };
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => writeJsonStateFileAtomic(this.statePath, snapshot))
      .then(() => this.onChange())
      .catch((error) => this.onError(error));
  }
}

export function configureSelfImprovementRequestState(state: SelfImprovementRequestState): void {
  configuredState = state;
}

export function getSelfImprovementRequestState(): SelfImprovementRequestState {
  if (!configuredState) throw new Error("Self-improvement request state is not configured.");
  return configuredState;
}
