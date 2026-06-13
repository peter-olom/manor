import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  CodexThreadRecord,
  ScratchPadAttachmentView,
  ScratchPadDepth,
  ScratchPadDossierSummaryView,
  ScratchPadItemStatus,
  ScratchPadItemView,
  ScratchPadReadinessStatus,
  ScratchPadReadinessView,
  ScratchPadResultKind,
  ScratchPadWorkspaceMode,
  ScratchPadView
} from "./types.js";
import { isManagedWorktree } from "./repo-worktree.js";

type ScratchPadPersistedState = {
  items?: ScratchPadItemView[];
};

type ScratchPadItemInput = {
  title?: string | null;
  text: string;
  depth?: ScratchPadDepth | null;
  resultKind?: ScratchPadResultKind | null;
  cwd?: string | null;
  workspaceMode?: ScratchPadWorkspaceMode | null;
  attachments?: ScratchPadAttachmentView[];
};

const ACTIVE_STATUSES = new Set<ScratchPadItemStatus>(["captured", "exploring", "ready_for_review"]);
const STATUS_ORDER: Record<ScratchPadItemStatus, number> = {
  ready_for_review: 0,
  exploring: 1,
  captured: 2,
  parked: 3,
  accepted: 4,
  dismissed: 5
};

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeMultilineText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function deriveTitle(text: string): string {
  const firstLine = text.split(/\n/).find((line) => line.trim())?.trim() ?? "Scratch item";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function normalizeDepth(value: unknown): ScratchPadDepth {
  return value === "quick" || value === "prototype" || value === "plan" ? value : "deep";
}

function normalizeResultKind(value: unknown): ScratchPadResultKind {
  return value === "prototype" || value === "plan" || value === "recommendation" ? value : "research";
}

function normalizeStatus(value: unknown): ScratchPadItemStatus {
  if (
    value === "exploring" ||
    value === "ready_for_review" ||
    value === "accepted" ||
    value === "parked" ||
    value === "dismissed"
  ) {
    return value;
  }
  return "captured";
}

function normalizeWorkspaceMode(value: unknown, cwd: string | null, threadId: string | null): ScratchPadWorkspaceMode {
  if (value === "managed_worktree" || value === "existing") {
    return value;
  }
  if (cwd && isManagedWorktree(cwd)) {
    return "managed_worktree";
  }
  if (cwd || threadId) {
    return "existing";
  }
  return "managed_worktree";
}

function cloneItem(item: ScratchPadItemView): ScratchPadItemView {
  return {
    ...item,
    readiness: { ...item.readiness },
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    dossier: { ...item.dossier, reviewerConcerns: [...item.dossier.reviewerConcerns] }
  };
}

function normalizeAttachment(value: unknown): ScratchPadAttachmentView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<ScratchPadAttachmentView>;
  const referenceId = normalizeText(record.referenceId) || normalizeText(record.id);
  const name = normalizeText(record.name) || "Attachment";
  if (!referenceId) {
    return null;
  }
  const mimeType = normalizeText(record.mimeType) || "application/octet-stream";
  const kind = record.kind === "image" || mimeType.startsWith("image/") ? "image" : "file";
  const now = Date.now();
  return {
    id: normalizeText(record.id) || `${kind}-${referenceId}`,
    kind,
    referenceId,
    name,
    mimeType,
    sizeBytes: typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes) ? record.sizeBytes : null,
    url: normalizeText(record.url) || null,
    available: record.available !== false,
    used: Boolean(record.used),
    note: normalizeText(record.note) || null,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : now
  };
}

function defaultReadiness(status: ScratchPadReadinessStatus, updatedAt: number | null = null): ScratchPadReadinessView {
  const labels: Record<ScratchPadReadinessStatus, string> = {
    captured: "captured",
    exploring: "working",
    reviewing: "reviewing",
    needs_rework: "needs work",
    ready: "ready",
    accepted: "accepted",
    parked: "parked",
    dismissed: "dismissed",
    blocked: "blocked"
  };
  const summaries: Record<ScratchPadReadinessStatus, string> = {
    captured: "Queued for async work.",
    exploring: "Worker is investigating.",
    reviewing: "Butler is reviewing the worker evidence.",
    needs_rework: "Butler found gaps and should send one rework pass.",
    ready: "Dossier is ready for an operator decision.",
    accepted: "Operator accepted this scratch result.",
    parked: "Operator parked this scratch result.",
    dismissed: "Operator dismissed this scratch result.",
    blocked: "The worker or reviewer is blocked."
  };
  return {
    status,
    label: labels[status],
    summary: summaries[status],
    updatedAt
  };
}

function defaultDossier(status: ScratchPadReadinessStatus, attachments: ScratchPadAttachmentView[], updatedAt: number | null = null): ScratchPadDossierSummaryView {
  return {
    status,
    resultSummary: null,
    acceptedEvidence: 0,
    totalEvidence: 0,
    reviewerSummary: null,
    reviewerConcerns: [],
    attachmentSummary:
      attachments.length > 0
        ? `${attachments.filter((attachment) => attachment.available).length}/${attachments.length} attachments available.`
        : null,
    nextAction: null,
    risk: null,
    updatedAt
  };
}

function normalizeReadiness(value: unknown, fallbackStatus: ScratchPadReadinessStatus, updatedAt: number | null): ScratchPadReadinessView {
  if (!value || typeof value !== "object") {
    return defaultReadiness(fallbackStatus, updatedAt);
  }
  const record = value as Partial<ScratchPadReadinessView>;
  const status =
    record.status === "captured" ||
    record.status === "exploring" ||
    record.status === "reviewing" ||
    record.status === "needs_rework" ||
    record.status === "ready" ||
    record.status === "accepted" ||
    record.status === "parked" ||
    record.status === "dismissed" ||
    record.status === "blocked"
      ? record.status
      : fallbackStatus;
  return {
    ...defaultReadiness(status, updatedAt),
    label: normalizeText(record.label) || defaultReadiness(status, updatedAt).label,
    summary: normalizeText(record.summary) || defaultReadiness(status, updatedAt).summary,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : updatedAt
  };
}

function normalizeDossier(
  value: unknown,
  fallbackStatus: ScratchPadReadinessStatus,
  attachments: ScratchPadAttachmentView[],
  updatedAt: number | null
): ScratchPadDossierSummaryView {
  if (!value || typeof value !== "object") {
    return defaultDossier(fallbackStatus, attachments, updatedAt);
  }
  const record = value as Partial<ScratchPadDossierSummaryView>;
  const base = defaultDossier(fallbackStatus, attachments, updatedAt);
  return {
    ...base,
    status: base.status,
    resultSummary: normalizeText(record.resultSummary) || null,
    acceptedEvidence:
      typeof record.acceptedEvidence === "number" && Number.isFinite(record.acceptedEvidence) ? Math.max(0, Math.trunc(record.acceptedEvidence)) : 0,
    totalEvidence:
      typeof record.totalEvidence === "number" && Number.isFinite(record.totalEvidence) ? Math.max(0, Math.trunc(record.totalEvidence)) : 0,
    reviewerSummary: normalizeText(record.reviewerSummary) || null,
    reviewerConcerns: Array.isArray(record.reviewerConcerns)
      ? record.reviewerConcerns.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
      : [],
    attachmentSummary: normalizeText(record.attachmentSummary) || base.attachmentSummary,
    nextAction: normalizeText(record.nextAction) || null,
    risk: normalizeText(record.risk) || null,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : updatedAt
  };
}

function readinessFromReviewStatus(status: ScratchPadItemStatus): ScratchPadReadinessStatus {
  return status === "accepted" || status === "parked" || status === "dismissed" ? status : status === "ready_for_review" ? "ready" : status;
}

export class ScratchPadStore extends EventEmitter {
  private readonly statePath: string;
  private readonly items = new Map<string, ScratchPadItemView>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(statePath: string) {
    super();
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const data = JSON.parse(raw) as ScratchPadPersistedState;
      this.items.clear();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const normalized = this.normalizeItem(item);
        if (normalized) {
          this.items.set(normalized.id, normalized);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.items.clear();
      }
    }
  }

  create(input: ScratchPadItemInput): ScratchPadItemView {
    const text = normalizeMultilineText(input.text);
    if (!text) {
      throw new Error("text is required");
    }

    const now = Date.now();
    const attachments = (input.attachments ?? []).map((attachment) => normalizeAttachment(attachment)).filter((attachment): attachment is ScratchPadAttachmentView => Boolean(attachment));
    const item: ScratchPadItemView = {
      id: crypto.randomUUID(),
      title: normalizeText(input.title) || deriveTitle(text),
      text,
      status: "captured",
      readiness: defaultReadiness("captured", now),
      depth: normalizeDepth(input.depth),
      resultKind: normalizeResultKind(input.resultKind),
      attachments,
      dossier: defaultDossier("captured", attachments, now),
      cwd: normalizeText(input.cwd) || null,
      workspaceMode: input.workspaceMode === "existing" ? "existing" : "managed_worktree",
      branchName: null,
      threadId: null,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      reviewedAt: null
    };
    this.items.set(item.id, item);
    this.saveAndEmit();
    return cloneItem(item);
  }

  get(itemId: string): ScratchPadItemView | null {
    const item = this.items.get(itemId);
    return item ? cloneItem(item) : null;
  }

  start(
    itemId: string,
    input: {
      threadId: string;
      cwd?: string | null;
      workspaceMode?: ScratchPadWorkspaceMode | null;
      branchName?: string | null;
      depth?: ScratchPadDepth | null;
      resultKind?: ScratchPadResultKind | null;
    }
  ): ScratchPadItemView {
    const item = this.requireItem(itemId);
    const now = Date.now();
    const cwd = normalizeText(input.cwd) || item.cwd;
    const attachments = item.attachments.map((attachment) =>
      attachment.available ? { ...attachment, used: true, note: attachment.note ?? "Sent with worker brief." } : attachment
    );
    const next: ScratchPadItemView = {
      ...item,
      status: "exploring",
      readiness: defaultReadiness("exploring", now),
      depth: normalizeDepth(input.depth ?? item.depth),
      resultKind: normalizeResultKind(input.resultKind ?? item.resultKind),
      attachments,
      dossier: defaultDossier("exploring", attachments, now),
      cwd,
      workspaceMode: normalizeWorkspaceMode(input.workspaceMode ?? item.workspaceMode, cwd, input.threadId),
      branchName: normalizeText(input.branchName) || item.branchName,
      threadId: input.threadId,
      startedAt: item.startedAt ?? now,
      updatedAt: now
    };
    this.items.set(itemId, next);
    this.saveAndEmit();
    return cloneItem(next);
  }

  review(itemId: string, status: Extract<ScratchPadItemStatus, "accepted" | "parked" | "dismissed">, note?: string | null): ScratchPadItemView {
    const item = this.requireItem(itemId);
    const now = Date.now();
    const next: ScratchPadItemView = {
      ...item,
      status,
      readiness: defaultReadiness(status, now),
      dossier: { ...item.dossier, status, nextAction: null, updatedAt: now },
      reviewNote: normalizeText(note) || null,
      reviewedAt: now,
      updatedAt: now
    };
    this.items.set(itemId, next);
    this.saveAndEmit();
    return cloneItem(next);
  }

  remove(itemId: string): ScratchPadItemView | null {
    const item = this.items.get(itemId);
    if (!item) {
      return null;
    }
    this.items.delete(itemId);
    this.saveAndEmit();
    return cloneItem(item);
  }

  removeAttachment(itemId: string, attachmentId: string): ScratchPadItemView {
    const item = this.requireItem(itemId);
    const now = Date.now();
    const attachments = item.threadId
      ? item.attachments.map((attachment) =>
          attachment.id === attachmentId
            ? { ...attachment, available: false, note: "Unavailable after job start." }
            : attachment
        )
      : item.attachments.filter((attachment) => attachment.id !== attachmentId);
    const next: ScratchPadItemView = {
      ...item,
      attachments,
      dossier: { ...item.dossier, attachmentSummary: defaultDossier(item.dossier.status, attachments, now).attachmentSummary, updatedAt: now },
      updatedAt: now
    };
    this.items.set(itemId, next);
    this.saveAndEmit();
    return cloneItem(next);
  }

  getSnapshot(getThread?: (threadId: string) => CodexThreadRecord | null | undefined): ScratchPadView {
    const items = [...this.items.values()].map((item) => this.toView(item, getThread));
    items.sort((left, right) => {
      const activeDelta = Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status));
      if (activeDelta !== 0) return activeDelta;
      const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      if (statusDelta !== 0) return statusDelta;
      return right.updatedAt - left.updatedAt;
    });

    const counts = {
      captured: 0,
      exploring: 0,
      ready_for_review: 0,
      accepted: 0,
      parked: 0,
      dismissed: 0
    } satisfies Record<ScratchPadItemStatus, number>;
    const readinessCounts = {
      captured: 0,
      exploring: 0,
      reviewing: 0,
      needs_rework: 0,
      ready: 0,
      accepted: 0,
      parked: 0,
      dismissed: 0,
      blocked: 0
    } satisfies Record<ScratchPadReadinessStatus, number>;
    for (const item of items) {
      counts[item.status] += 1;
      readinessCounts[item.readiness.status] += 1;
    }
    return { items, counts, readinessCounts };
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persistNow();
  }

  private toView(item: ScratchPadItemView, getThread?: (threadId: string) => CodexThreadRecord | null | undefined): ScratchPadItemView {
    const thread = item.threadId && getThread ? getThread(item.threadId) ?? null : null;
    const readiness = this.deriveReadiness(item, thread);
    const dossier = this.deriveDossier(item, thread, readiness.status);
    const status =
      item.status === "exploring" && readiness.status === "ready"
        ? "ready_for_review"
        : item.status === "ready_for_review" && readiness.status !== "ready" && readiness.status !== "accepted" && readiness.status !== "parked" && readiness.status !== "dismissed"
          ? "exploring"
          : item.status;
    return {
      ...item,
      status,
      readiness,
      dossier,
      updatedAt: Math.max(item.updatedAt, readiness.updatedAt ?? 0, dossier.updatedAt ?? 0)
    };
  }

  private deriveReadiness(item: ScratchPadItemView, thread: CodexThreadRecord | null): ScratchPadReadinessView {
    const reviewedStatus = readinessFromReviewStatus(item.status);
    if (reviewedStatus === "accepted" || reviewedStatus === "parked" || reviewedStatus === "dismissed") {
      return defaultReadiness(reviewedStatus, item.reviewedAt ?? item.updatedAt);
    }
    if (item.status === "captured" || !item.threadId) {
      return defaultReadiness("captured", item.updatedAt);
    }
    const checklist = thread?.supervisionChecklist ?? null;
    const contract = thread?.executionContract ?? null;
    const workerReport = thread?.workerReport ?? null;
    if (workerReport?.status === "blocked" || thread?.supervisor?.blocked || contract?.reviewPanelSummary.status === "blocked") {
      return defaultReadiness("blocked", workerReport?.updatedAt ?? contract?.reviewPanelSummary.updatedAt ?? item.updatedAt);
    }
    if (checklist?.items.some((entry) => entry.status === "rejected" || entry.queuedInstruction)) {
      return defaultReadiness("needs_rework", checklist.updatedAt);
    }
    if (contract?.reviewPanelSummary.status === "concerns") {
      return defaultReadiness("needs_rework", contract.reviewPanelSummary.updatedAt ?? item.updatedAt);
    }
    if (workerReport && checklist?.reviewState === "reviewed") {
      return defaultReadiness("ready", Math.max(workerReport.updatedAt, checklist.updatedAt, contract?.reviewPanelSummary.updatedAt ?? 0));
    }
    if (workerReport) {
      return defaultReadiness("reviewing", Math.max(workerReport.updatedAt, checklist?.updatedAt ?? 0, contract?.reviewPanelSummary.updatedAt ?? 0));
    }
    return defaultReadiness("exploring", item.startedAt ?? item.updatedAt);
  }

  private deriveDossier(
    item: ScratchPadItemView,
    thread: CodexThreadRecord | null,
    status: ScratchPadReadinessStatus
  ): ScratchPadDossierSummaryView {
    const checklist = thread?.supervisionChecklist ?? null;
    const contract = thread?.executionContract ?? null;
    const workerReport = thread?.workerReport ?? null;
    const totalEvidence = checklist?.items.length ?? contract?.verificationMatrix.length ?? 0;
    const acceptedEvidence = checklist?.items.filter((entry) => entry.status === "accepted" || entry.status === "waived").length ?? 0;
    const reviewerConcerns = [
      ...new Set(contract?.reviewPanel.flatMap((entry) => [entry.requiredFollowUp, ...entry.concerns].filter((value): value is string => Boolean(value))) ?? [])
    ].slice(0, 5);
    const usedAttachments = item.attachments.filter((attachment) => attachment.used).length;
    const availableAttachments = item.attachments.filter((attachment) => attachment.available).length;
    const attachmentSummary =
      item.attachments.length > 0
        ? `${usedAttachments}/${item.attachments.length} attachments sent; ${availableAttachments}/${item.attachments.length} available.`
        : null;
    const rejected = checklist?.items.find((entry) => entry.status === "rejected" || entry.queuedInstruction);
    const waived = checklist?.items.filter((entry) => entry.status === "waived") ?? [];
    const waiverSummary = waived.map((entry) => entry.butlerNote || entry.text).filter(Boolean).join("; ");
    const nextAction =
      status === "ready"
        ? "Decide whether to accept, park, or dismiss."
        : status === "needs_rework"
          ? "Send one private rework pass."
          : status === "blocked"
            ? "Open the thread and inspect the blocker."
            : status === "reviewing"
              ? "Wait for Butler review."
              : status === "exploring"
                ? "Wait for the worker result."
                : null;
    return {
      status,
      resultSummary: workerReport?.summary ?? item.dossier.resultSummary,
      acceptedEvidence,
      totalEvidence,
      reviewerSummary: contract?.reviewPanelSummary.summary ?? item.dossier.reviewerSummary,
      reviewerConcerns,
      attachmentSummary,
      nextAction,
      risk: rejected?.queuedInstruction ?? rejected?.butlerNote ?? (waiverSummary || null),
      updatedAt: Math.max(workerReport?.updatedAt ?? 0, checklist?.updatedAt ?? 0, contract?.reviewPanelSummary.updatedAt ?? 0, item.updatedAt)
    };
  }

  private normalizeItem(item: ScratchPadItemView): ScratchPadItemView | null {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.text !== "string") {
      return null;
    }
    const text = normalizeMultilineText(item.text);
    if (!text) {
      return null;
    }
    const now = Date.now();
    const cwd = normalizeText(item.cwd) || null;
    const threadId = normalizeText(item.threadId) || null;
    const status = normalizeStatus(item.status);
    const readinessStatus = readinessFromReviewStatus(status);
    const attachments = Array.isArray(item.attachments)
      ? item.attachments.map((attachment) => normalizeAttachment(attachment)).filter((attachment): attachment is ScratchPadAttachmentView => Boolean(attachment))
      : [];
    const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : now;
    return {
      id: item.id.trim() || crypto.randomUUID(),
      title: normalizeText(item.title) || deriveTitle(text),
      text,
      status,
      readiness: normalizeReadiness(item.readiness, readinessStatus, updatedAt),
      depth: normalizeDepth(item.depth),
      resultKind: normalizeResultKind(item.resultKind),
      attachments,
      dossier: normalizeDossier(item.dossier, readinessStatus, attachments, updatedAt),
      cwd,
      workspaceMode: normalizeWorkspaceMode(item.workspaceMode, cwd, threadId),
      branchName: normalizeText(item.branchName) || null,
      threadId,
      reviewNote: normalizeText(item.reviewNote) || null,
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : now,
      updatedAt,
      startedAt: typeof item.startedAt === "number" && Number.isFinite(item.startedAt) ? item.startedAt : null,
      reviewedAt: typeof item.reviewedAt === "number" && Number.isFinite(item.reviewedAt) ? item.reviewedAt : null
    };
  }

  private requireItem(itemId: string): ScratchPadItemView {
    const item = this.items.get(itemId);
    if (!item) {
      throw new Error("Scratch item not found");
    }
    return item;
  }

  private saveAndEmit(): void {
    this.queueSave();
    this.emit("change");
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistNow();
    }, 150);
  }

  private async persistNow(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify({ items: [...this.items.values()] }, null, 2));
  }
}
