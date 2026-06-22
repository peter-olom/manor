import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { readJsonStateFile, writeJsonStateFileAtomic } from "./json-state-file.js";
import type { ButlerStateStore } from "./state-store.js";
import type { PairChat, PairDetail, PairLane, PairMessage, PairRole, PairStatus, PairSummary } from "../shared/pairing.js";

type PersistedPairState = {
  pairs: PairChat[];
};

type AppendMessageInput = {
  role: PairRole;
  lane: PairLane;
  text: string;
  sourceThreadId?: string | null;
  memoryObservationId?: string | null;
  metadata?: Record<string, string>;
  at?: number;
};

const MAX_PAIR_MESSAGES = 2000;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function titleFromText(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "Untitled Butler chat";
  }
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function summarizePair(pair: PairChat): PairSummary {
  const { messages: _messages, ...summary } = pair;
  return {
    ...summary,
    messageCount: pair.messages.length,
    lastMessage: pair.messages.at(-1) ?? null
  };
}

function deriveStatus(pair: PairChat, store: ButlerStateStore): PairStatus {
  if (!pair.worker) {
    return pair.messages.some((message) => message.role === "user") ? "ready_to_handoff" : "idle";
  }

  const thread = store.getThread(pair.worker.threadId);
  if (thread?.status === "active") {
    return "worker_running";
  }
  if (pair.worker.lastReportStatus === "blocked") {
    return "blocked";
  }
  if (pair.worker.lastReportAt && (!pair.worker.lastRevertAt || pair.worker.lastReportAt > pair.worker.lastRevertAt)) {
    return "needs_butler_review";
  }
  return "idle";
}

export class PairStore extends EventEmitter {
  private pairs = new Map<string, PairChat>();
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
    for (const pair of loaded.pairs) {
      if (!pair?.id || !Array.isArray(pair.messages)) {
        continue;
      }
      this.pairs.set(pair.id, {
        ...pair,
        status: deriveStatus(pair, this.store),
        messages: pair.messages.slice(-MAX_PAIR_MESSAGES)
      });
    }
  }

  listSummaries(): PairSummary[] {
    return [...this.pairs.values()]
      .map((pair) => {
        const nextStatus = deriveStatus(pair, this.store);
        return summarizePair({ ...pair, status: nextStatus });
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getPair(pairId: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    return pair ? { ...pair, messages: [...pair.messages], status: deriveStatus(pair, this.store) } : null;
  }

  getPairDetail(pairId: string, before: number | null, limit: number): PairDetail | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }

    const safeLimit = Math.max(20, Math.min(250, Math.trunc(limit)));
    const endExclusive = before === null ? pair.messages.length : Math.max(0, Math.min(pair.messages.length, Math.trunc(before)));
    const start = Math.max(0, endExclusive - safeLimit);
    return {
      ...pair,
      status: deriveStatus(pair, this.store),
      messages: pair.messages.slice(start, endExclusive),
      messageCount: pair.messages.length,
      loadedStart: start,
      hasMore: start > 0
    };
  }

  createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): PairChat {
    const now = Date.now();
    const id = crypto.randomUUID();
    const pair: PairChat = {
      id,
      title: titleFromText(input.title ?? "New session"),
      status: "idle",
      projectId: null,
      projectLabel: null,
      createdAt: now,
      updatedAt: now,
      defaultCwd: normalizeText(input.defaultCwd) || null,
      worker: null,
      memoryQuery: null,
      lastHandoffPrompt: null,
      messages: []
    };
    this.pairs.set(pair.id, pair);
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id)!;
  }

  updatePairTitle(pairId: string, rawTitle: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (!normalizeText(rawTitle)) {
      return null;
    }
    const next = titleFromText(rawTitle);
    if (next === pair.title) {
      return this.getPair(pair.id);
    }
    pair.title = next;
    pair.updatedAt = Date.now();
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  appendMessage(pairId: string, input: AppendMessageInput): PairMessage {
    const pair = this.requirePair(pairId);
    const now = input.at ?? Date.now();
    const message: PairMessage = {
      id: crypto.randomUUID(),
      role: input.role,
      lane: input.lane,
      text: input.text.trim(),
      at: now,
      sourceThreadId: input.sourceThreadId ?? null,
      memoryObservationId: input.memoryObservationId ?? null,
      metadata: input.metadata ?? {}
    };
    if (!message.text) {
      throw new Error("message text is required");
    }

    pair.messages.push(message);
    if (pair.messages.length > MAX_PAIR_MESSAGES) {
      pair.messages.splice(0, pair.messages.length - MAX_PAIR_MESSAGES);
    }
    if ((pair.title === "New session" || pair.title === "New Butler chat") && input.role === "user") {
      pair.title = titleFromText(input.text);
    }
    pair.memoryQuery = input.role === "user" ? titleFromText(input.text) : pair.memoryQuery;
    pair.updatedAt = now;
    pair.status = deriveStatus(pair, this.store);
    this.queueSave();
    this.emit("change");
    return message;
  }

  attachWorker(pairId: string, input: { threadId: string; task: string; cwd?: string | null; handoffPrompt: string }): PairChat {
    const pair = this.requirePair(pairId);
    if (pair.worker) {
      throw new Error("This Butler chat already has a Codex worker.");
    }

    const now = Date.now();
    pair.worker = {
      threadId: input.threadId,
      status: "starting",
      task: input.task.trim(),
      cwd: normalizeText(input.cwd) || null,
      handoffPrompt: input.handoffPrompt,
      startedAt: now,
      lastRevertAt: null,
      lastReportAt: null,
      lastReportStatus: null,
      lastReportSummary: null
    };
    pair.lastHandoffPrompt = input.handoffPrompt;
    pair.updatedAt = now;
    pair.status = "worker_running";
    this.appendMessage(pair.id, {
      role: "butler",
      lane: "butler",
      text: `Worker ${input.threadId} is attached to this chat. I will challenge its evidence before accepting the result.`,
      sourceThreadId: input.threadId,
      metadata: { event: "worker.attached" },
      at: now
    });
    return this.getPair(pair.id)!;
  }

  noteWorkerHandoff(pairId: string, text: string): PairChat {
    const pair = this.requirePair(pairId);
    if (!pair.worker) {
      throw new Error("This Butler chat does not have a worker yet.");
    }
    pair.lastHandoffPrompt = text;
    pair.worker.handoffPrompt = text;
    pair.updatedAt = Date.now();
    this.appendMessage(pairId, {
      role: "butler",
      lane: "worker",
      text,
      sourceThreadId: pair.worker.threadId,
      metadata: { event: "worker.handoff" }
    });
    return this.getPair(pairId)!;
  }

  revertWorker(pairId: string, text?: string | null): PairChat {
    const pair = this.requirePair(pairId);
    if (!pair.worker) {
      throw new Error("This Butler chat does not have a worker yet.");
    }

    const thread = this.store.getThread(pair.worker.threadId);
    const report = this.store.getWorkerReport(pair.worker.threadId);
    const summary = normalizeText(text) ||
      report?.summary ||
      thread?.supervisor.latestAgentReply ||
      "Worker reverted without a structured report yet.";
    const now = Date.now();
    pair.worker.lastRevertAt = now;
    pair.worker.lastReportAt = report?.updatedAt ?? pair.worker.lastReportAt;
    pair.worker.lastReportStatus = report?.status ?? pair.worker.lastReportStatus;
    pair.worker.lastReportSummary = report?.summary ?? pair.worker.lastReportSummary;
    pair.updatedAt = now;
    this.appendMessage(pairId, {
      role: "worker",
      lane: "butler",
      text: summary,
      sourceThreadId: pair.worker.threadId,
      metadata: { event: "worker.reverted", reportStatus: report?.status ?? "unknown" },
      at: now
    });
    return this.getPair(pairId)!;
  }

  syncWorkerReports(): boolean {
    let changed = false;
    for (const pair of this.pairs.values()) {
      if (!pair.worker) {
        continue;
      }

      const thread = this.store.getThread(pair.worker.threadId);
      const report = this.store.getWorkerReport(pair.worker.threadId);
      pair.worker.status = thread?.status === "active" ? "running" : thread?.status === "idle" ? "idle" : thread?.status === "unknown" ? "unknown" : pair.worker.status;
      if (!report || report.updatedAt === pair.worker.lastReportAt) {
        pair.status = deriveStatus(pair, this.store);
        continue;
      }

      pair.worker.lastReportAt = report.updatedAt;
      pair.worker.lastReportStatus = report.status;
      pair.worker.lastReportSummary = report.summary;
      pair.updatedAt = Math.max(pair.updatedAt, report.updatedAt);
      pair.status = "needs_butler_review";
      pair.messages.push({
        id: crypto.randomUUID(),
        role: "worker",
        lane: "butler",
        text: `Worker report: ${report.summary}${report.details ? `\n\n${report.details}` : ""}`,
        at: report.updatedAt,
        sourceThreadId: pair.worker.threadId,
        memoryObservationId: null,
        metadata: { event: "worker.report", reportStatus: report.status }
      });
      changed = true;
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

  private requirePair(pairId: string): PairChat {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      throw new Error("Butler chat not found");
    }
    return pair;
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
      pairs: [...this.pairs.values()].sort((left, right) => left.createdAt - right.createdAt)
    } satisfies PersistedPairState);
  }
}
