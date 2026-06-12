import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {
  CodexThreadRecord,
  ScratchPadDepth,
  ScratchPadItemStatus,
  ScratchPadItemView,
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
  return { ...item };
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
    const item: ScratchPadItemView = {
      id: crypto.randomUUID(),
      title: normalizeText(input.title) || deriveTitle(text),
      text,
      status: "captured",
      depth: normalizeDepth(input.depth),
      resultKind: normalizeResultKind(input.resultKind),
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
    const next: ScratchPadItemView = {
      ...item,
      status: "exploring",
      depth: normalizeDepth(input.depth ?? item.depth),
      resultKind: normalizeResultKind(input.resultKind ?? item.resultKind),
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
    for (const item of items) {
      counts[item.status] += 1;
    }
    return { items, counts };
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persistNow();
  }

  private toView(item: ScratchPadItemView, getThread?: (threadId: string) => CodexThreadRecord | null | undefined): ScratchPadItemView {
    if (item.status !== "exploring" || !item.threadId || !getThread) {
      return cloneItem(item);
    }

    const thread = getThread(item.threadId);
    if (!thread?.workerReport) {
      return cloneItem(item);
    }
    return {
      ...item,
      status: "ready_for_review",
      updatedAt: Math.max(item.updatedAt, thread.workerReport.updatedAt)
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
    return {
      id: item.id.trim() || crypto.randomUUID(),
      title: normalizeText(item.title) || deriveTitle(text),
      text,
      status: normalizeStatus(item.status),
      depth: normalizeDepth(item.depth),
      resultKind: normalizeResultKind(item.resultKind),
      cwd,
      workspaceMode: normalizeWorkspaceMode(item.workspaceMode, cwd, threadId),
      branchName: normalizeText(item.branchName) || null,
      threadId,
      reviewNote: normalizeText(item.reviewNote) || null,
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : now,
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
