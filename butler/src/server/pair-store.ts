import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { readJsonStateFile, writeJsonStateFileAtomic } from "./json-state-file.js";
import type { ButlerStateStore } from "./state-store.js";
import type { PairChat, PairMessage, PairStatus, PairSummary } from "../shared/pairing.js";

type PersistedPairState = {
  pairs: PairChat[];
  lastUsedCompose?: LastUsedCompose | null;
};

export type LastUsedCompose = {
  butlerModel?: string | null;
  butlerThinkingLevel?: string | null;
  workerModel?: string | null;
  workerEffort?: string | null;
  workerRuntime?: "auto" | "openai" | "pi-rpc" | null;
  updatedAt?: number | null;
};

type PairSnapshotInput = {
  butlerSessionId?: string | null;
  butlerReady?: boolean;
  butlerPending?: boolean;
  butlerPendingReason?: string | null;
  butlerLastError?: string | null;
  messageCount?: number;
  lastMessage?: PairMessage | null;
  updatedAt?: number;
  butlerThinkingLevel?: string | null;
  butlerModel?: string | null;
  codexModel?: string | null;
  codexEffort?: string | null;
};

type PairComposeOverrideInput = {
  butlerThinkingLevel?: string | null;
  butlerModel?: string | null;
  codexModel?: string | null;
  codexEffort?: string | null;
  workerRuntime?: "auto" | "openai" | "pi-rpc" | null;
};

const DEFAULT_TITLE = "New session";

function normalizeLastUsedCompose(raw: LastUsedCompose | null | undefined): LastUsedCompose | null {
  if (!raw) return null;
  const butlerModel = typeof raw.butlerModel === "string" && raw.butlerModel.trim() ? raw.butlerModel : null;
  const butlerThinkingLevel = typeof raw.butlerThinkingLevel === "string" && raw.butlerThinkingLevel.trim() ? raw.butlerThinkingLevel : null;
  const workerModel = typeof raw.workerModel === "string" && raw.workerModel.trim() ? raw.workerModel : null;
  const workerEffort = typeof raw.workerEffort === "string" && raw.workerEffort.trim() ? raw.workerEffort : null;
  const workerRuntime = raw.workerRuntime === "auto" || raw.workerRuntime === "openai" || raw.workerRuntime === "pi-rpc" ? raw.workerRuntime : null;
  if (!butlerModel && !butlerThinkingLevel && !workerModel && !workerEffort && !workerRuntime) return null;
  return {
    butlerModel,
    butlerThinkingLevel,
    workerModel,
    workerEffort,
    workerRuntime,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function titleFromText(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "Untitled Butler session";
  }
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

export function pairTitleIsDefault(title: string | null | undefined): boolean {
  return titleFromText(title ?? DEFAULT_TITLE) === DEFAULT_TITLE;
}

function threadIsStillRunning(thread: ReturnType<ButlerStateStore["getThread"]>): boolean {
  const latestTurn = thread?.turns.at(-1);
  return thread?.status === "active" || latestTurn?.status === "inProgress" || latestTurn?.status === "started";
}

function reportCloseoutMessageId(threadId: string, turnId: string): string {
  return `callback-${threadId}:${turnId}`;
}

function reviewedReportUpdatedAt(pair: PairChat, store: ButlerStateStore, message: PairMessage | null | undefined): number | null {
  if (!pair.worker || !message || message.role !== "butler") {
    return null;
  }
  const report = store.getWorkerReport(pair.worker.threadId);
  if (!report || report.status !== "completed") {
    return null;
  }
  return message.id === reportCloseoutMessageId(report.threadId, report.turnId) ? report.updatedAt : null;
}

function emptyPair(input: { id: string; title?: string | null; defaultCwd?: string | null; now: number }): PairChat {
  return {
    id: input.id,
    title: titleFromText(input.title ?? DEFAULT_TITLE),
    status: "idle",
    projectId: null,
    projectLabel: null,
    createdAt: input.now,
    updatedAt: input.now,
    defaultCwd: normalizeText(input.defaultCwd) || null,
    butlerSessionId: input.id,
    butlerReady: false,
    butlerPending: false,
    butlerPendingReason: null,
    butlerLastError: null,
    worker: null,
    memoryQuery: null,
    lastHandoffPrompt: null,
    messageCount: 0,
    lastMessage: null,
    butlerThinkingLevel: null,
    butlerModel: null,
    codexModel: null,
    codexEffort: null,
    workerRuntime: null
  };
}

function normalizePair(raw: Partial<PairChat> & { id?: string }, store: ButlerStateStore): PairChat | null {
  if (!raw.id) {
    return null;
  }
  const now = Date.now();
  const pair = emptyPair({
    id: raw.id,
    title: raw.title ?? DEFAULT_TITLE,
    defaultCwd: raw.defaultCwd,
    now: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now
  });
  pair.status = raw.status === "butler_running" || raw.status === "worker_running" || raw.status === "needs_butler_review" || raw.status === "blocked" ? raw.status : "idle";
  pair.projectId = typeof raw.projectId === "string" ? raw.projectId : null;
  pair.projectLabel = typeof raw.projectLabel === "string" ? raw.projectLabel : null;
  pair.updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : pair.createdAt;
  pair.butlerSessionId = typeof raw.butlerSessionId === "string" && raw.butlerSessionId.trim() ? raw.butlerSessionId : pair.id;
  pair.butlerReady = raw.butlerReady === true;
  pair.butlerPending = raw.butlerPending === true;
  pair.butlerPendingReason = typeof raw.butlerPendingReason === "string" && raw.butlerPendingReason.trim() ? raw.butlerPendingReason : null;
  pair.butlerLastError = typeof raw.butlerLastError === "string" && raw.butlerLastError.trim() ? raw.butlerLastError : null;
  pair.worker = raw.worker ? {
    ...raw.worker,
    lastReviewedReportAt:
      typeof raw.worker.lastReviewedReportAt === "number" && Number.isFinite(raw.worker.lastReviewedReportAt)
        ? raw.worker.lastReviewedReportAt
        : null
  } : null;
  pair.memoryQuery = typeof raw.memoryQuery === "string" && raw.memoryQuery.trim() ? raw.memoryQuery : null;
  pair.lastHandoffPrompt = typeof raw.lastHandoffPrompt === "string" && raw.lastHandoffPrompt.trim() ? raw.lastHandoffPrompt : null;
  pair.messageCount = typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount) ? Math.max(0, Math.trunc(raw.messageCount)) : 0;
  pair.lastMessage = raw.lastMessage ?? null;
    pair.butlerThinkingLevel = typeof raw.butlerThinkingLevel === "string" && raw.butlerThinkingLevel.trim() ? raw.butlerThinkingLevel : null;
    pair.butlerModel = typeof raw.butlerModel === "string" && raw.butlerModel.trim() ? raw.butlerModel : null;
    pair.codexModel = typeof raw.codexModel === "string" && raw.codexModel.trim() ? raw.codexModel : null;
    pair.codexEffort = typeof raw.codexEffort === "string" && raw.codexEffort.trim() ? raw.codexEffort : null;
    pair.workerRuntime = raw.workerRuntime === "auto" || raw.workerRuntime === "openai" || raw.workerRuntime === "pi-rpc" ? raw.workerRuntime : null;
  pair.status = deriveStatus(pair, store);
  return pair;
}

function deriveStatus(pair: PairChat, store: ButlerStateStore): PairStatus {
  if (pair.butlerPendingReason) {
    return "blocked";
  }
  if (pair.worker) {
    const report = store.getWorkerReport(pair.worker.threadId);
    const thread = store.getThread(pair.worker.threadId);
    if (report?.status === "blocked" && !threadIsStillRunning(thread)) {
      return "blocked";
    }
    const reportNeedsReview =
      report &&
      (report.status === "completed" || !threadIsStillRunning(thread)) &&
      (!pair.worker.lastRevertAt || report.updatedAt > pair.worker.lastRevertAt) &&
      (!pair.worker.lastReviewedReportAt || report.updatedAt > pair.worker.lastReviewedReportAt);
    if (reportNeedsReview) {
      return "needs_butler_review";
    }
    if (threadIsStillRunning(thread) || pair.worker.status === "running" || pair.worker.status === "starting") {
      return "worker_running";
    }
  }
  return pair.butlerPending ? "butler_running" : "idle";
}

export class PairStore extends EventEmitter {
  private pairs = new Map<string, PairChat>();
  private lastUsedCompose: LastUsedCompose | null = null;
  private saveInFlight: Promise<void> | null = null;
  private saveQueued = false;

  constructor(
    private readonly statePath: string,
    private readonly store: ButlerStateStore
  ) {
    super();
  }

  async load(): Promise<void> {
    const loaded = await readJsonStateFile<PersistedPairState>(this.statePath, { pairs: [] });
    this.pairs.clear();
    for (const raw of loaded.pairs) {
      const pair = normalizePair(raw, this.store);
      if (pair) {
        this.pairs.set(pair.id, pair);
      }
    }
    this.lastUsedCompose = normalizeLastUsedCompose(loaded.lastUsedCompose);
  }

  getLastUsedCompose(): LastUsedCompose | null {
    return this.lastUsedCompose ? { ...this.lastUsedCompose } : null;
  }

  listSummaries(): PairSummary[] {
    return [...this.pairs.values()]
      .map((pair) => ({ ...pair, status: deriveStatus(pair, this.store) }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getPair(pairId: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    return pair ? { ...pair, status: deriveStatus(pair, this.store) } : null;
  }

  createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): PairChat {
    const now = Date.now();
    const pair = emptyPair({ id: crypto.randomUUID(), title: input.title ?? DEFAULT_TITLE, defaultCwd: input.defaultCwd, now });
    if (this.lastUsedCompose) {
      pair.butlerThinkingLevel = this.lastUsedCompose.butlerThinkingLevel ?? null;
      pair.butlerModel = this.lastUsedCompose.butlerModel ?? null;
      pair.codexModel = this.lastUsedCompose.workerModel ?? null;
      pair.codexEffort = this.lastUsedCompose.workerEffort ?? null;
      pair.workerRuntime = this.lastUsedCompose.workerRuntime ?? null;
    }
    this.pairs.set(pair.id, pair);
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id)!;
  }

  updatePairTitle(pairId: string, rawTitle: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair || !normalizeText(rawTitle)) {
      return null;
    }
    const next = titleFromText(rawTitle);
    if (next !== pair.title) {
      pair.title = next;
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pair.id);
  }

  updateDefaultPairTitle(pairId: string, rawTitle: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair || !pairTitleIsDefault(pair.title) || !normalizeText(rawTitle)) {
      return null;
    }
    const next = titleFromText(rawTitle);
    if (next !== pair.title) {
      pair.title = next;
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pair.id);
  }

  updatePairSnapshot(pairId: string, snapshot: PairSnapshotInput): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (snapshot.butlerSessionId !== undefined) pair.butlerSessionId = snapshot.butlerSessionId;
    if (snapshot.butlerReady !== undefined) pair.butlerReady = snapshot.butlerReady;
    if (snapshot.butlerPending !== undefined) pair.butlerPending = snapshot.butlerPending;
    if (snapshot.butlerPendingReason !== undefined) pair.butlerPendingReason = snapshot.butlerPendingReason;
    if (snapshot.butlerLastError !== undefined) pair.butlerLastError = snapshot.butlerLastError;
    if (snapshot.messageCount !== undefined) pair.messageCount = Math.max(0, Math.trunc(snapshot.messageCount));
    if (snapshot.lastMessage !== undefined) pair.lastMessage = snapshot.lastMessage;
    const reviewedAt = reviewedReportUpdatedAt(pair, this.store, snapshot.lastMessage);
    if (reviewedAt && pair.worker && (!pair.worker.lastReviewedReportAt || reviewedAt > pair.worker.lastReviewedReportAt)) {
      pair.worker.lastReviewedReportAt = reviewedAt;
    }
    if (snapshot.butlerThinkingLevel !== undefined) pair.butlerThinkingLevel = snapshot.butlerThinkingLevel;
    if (snapshot.butlerModel !== undefined) pair.butlerModel = snapshot.butlerModel;
    if (snapshot.codexModel !== undefined) pair.codexModel = snapshot.codexModel;
    if (snapshot.codexEffort !== undefined) pair.codexEffort = snapshot.codexEffort;
    pair.status = deriveStatus(pair, this.store);
    pair.updatedAt = Math.max(pair.updatedAt, snapshot.updatedAt ?? pair.lastMessage?.at ?? Date.now());
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  updatePairComposeOverrides(pairId: string, override: PairComposeOverrideInput): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (override.butlerThinkingLevel !== undefined) pair.butlerThinkingLevel = override.butlerThinkingLevel;
    if (override.butlerModel !== undefined) pair.butlerModel = override.butlerModel;
    if (override.codexModel !== undefined) pair.codexModel = override.codexModel;
    if (override.codexEffort !== undefined) pair.codexEffort = override.codexEffort;
    if (override.workerRuntime !== undefined) pair.workerRuntime = override.workerRuntime;
    pair.updatedAt = Math.max(pair.updatedAt, Date.now());
    this.lastUsedCompose = normalizeLastUsedCompose({
      butlerModel: override.butlerModel !== undefined ? override.butlerModel : this.lastUsedCompose?.butlerModel ?? null,
      butlerThinkingLevel: override.butlerThinkingLevel !== undefined ? override.butlerThinkingLevel : this.lastUsedCompose?.butlerThinkingLevel ?? null,
      workerModel: override.codexModel !== undefined ? override.codexModel : this.lastUsedCompose?.workerModel ?? null,
      workerEffort: override.codexEffort !== undefined ? override.codexEffort : this.lastUsedCompose?.workerEffort ?? null,
      workerRuntime: override.workerRuntime !== undefined ? override.workerRuntime : this.lastUsedCompose?.workerRuntime ?? null,
      updatedAt: Date.now()
    });
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  attachWorker(pairId: string, input: { threadId: string; task?: string | null; cwd?: string | null; handoffPrompt?: string | null }): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (pair.worker && pair.worker.threadId !== input.threadId) {
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
      return this.getPair(pair.id);
    }
    const thread = this.store.getThread(input.threadId);
    const now = Date.now();
    pair.worker = {
      threadId: input.threadId,
      status: thread?.status === "active" ? "running" : thread?.status === "idle" ? "idle" : "starting",
      task: normalizeText(input.task) || thread?.executionContract?.requestedTask || thread?.supervisor.latestUserPrompt || "Delegated Codex job",
      cwd: normalizeText(input.cwd) || thread?.cwd || null,
      handoffPrompt: normalizeText(input.handoffPrompt) || thread?.executionContract?.requestedTask || "",
      startedAt: now,
      lastRevertAt: null,
      lastReportAt: null,
      lastReportStatus: null,
      lastReportSummary: null,
      lastReviewedReportAt: null
    };
    pair.lastHandoffPrompt = pair.worker.handoffPrompt || null;
    pair.updatedAt = now;
    pair.status = deriveStatus(pair, this.store);
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  syncWorkerReports(): boolean {
    let changed = false;
    for (const pair of this.pairs.values()) {
      if (!pair.worker) {
        continue;
      }
      const thread = this.store.getThread(pair.worker.threadId);
      const report = this.store.getWorkerReport(pair.worker.threadId);
      const nextStatus = thread?.status === "active" ? "running" : thread?.status === "idle" ? "idle" : thread?.status === "unknown" ? "unknown" : pair.worker.status;
      if (pair.worker.status !== nextStatus) {
        pair.worker.status = nextStatus;
        changed = true;
      }
      if (report && report.updatedAt !== pair.worker.lastReportAt) {
        pair.worker.lastReportAt = report.updatedAt;
        pair.worker.lastReportStatus = report.status;
        pair.worker.lastReportSummary = report.summary;
        pair.updatedAt = Math.max(pair.updatedAt, report.updatedAt);
        changed = true;
      }
      const reviewedAt = reviewedReportUpdatedAt(pair, this.store, pair.lastMessage);
      if (reviewedAt && (!pair.worker.lastReviewedReportAt || reviewedAt > pair.worker.lastReviewedReportAt)) {
        pair.worker.lastReviewedReportAt = reviewedAt;
        changed = true;
      }
      const nextPairStatus = deriveStatus(pair, this.store);
      if (pair.status !== nextPairStatus) {
        pair.status = nextPairStatus;
        changed = true;
      }
    }
    if (changed) {
      this.queueSave();
      this.emit("change");
    }
    return changed;
  }

  deletePair(pairId: string): boolean {
    const deleted = this.pairs.delete(pairId);
    if (deleted) {
      this.queueSave();
      this.emit("change");
    }
    return deleted;
  }

  private queueSave(): void {
    this.saveQueued = true;
    if (this.saveInFlight) {
      return;
    }
    this.saveInFlight = this.flushSave().finally(() => {
      this.saveInFlight = null;
      if (this.saveQueued) {
        this.queueSave();
      }
    });
  }

  private async flushSave(): Promise<void> {
    this.saveQueued = false;
    await writeJsonStateFileAtomic(this.statePath, {
      pairs: [...this.pairs.values()].sort((left, right) => left.createdAt - right.createdAt),
      lastUsedCompose: this.lastUsedCompose
    } satisfies PersistedPairState);
  }
}
