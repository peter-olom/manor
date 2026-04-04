import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AppSnapshot,
  ButlerMessageView,
  ButlerWindow,
  CodexCompactionView,
  CodexContextUsageView,
  CodexEventEntry,
  CodexItemRecord,
  CodexThreadRecord,
  CodexThreadStatus,
  CodexThreadSummary,
  CodexTurnRecord,
  PersistedUiState
} from "./types.js";

const MAX_EVENT_LOG = 80;

function emptyCodexContextUsage(): CodexContextUsageView {
  return {
    tokens: null,
    contextWindow: null,
    percent: null
  };
}

function emptyCodexCompaction(): CodexCompactionView {
  return {
    active: false,
    count: 0,
    lastStartedAt: null,
    lastCompletedAt: null
  };
}

function normalizeStatus(status: unknown): CodexThreadStatus {
  if (status && typeof status === "object" && "type" in status && typeof status.type === "string") {
    if (status.type === "active" || status.type === "idle") {
      return status.type;
    }
  }

  return "unknown";
}

function summarizeItem(item: Record<string, unknown>): string {
  if (item.type === "agentMessage" && typeof item.text === "string") {
    return item.text;
  }

  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n");
    return text;
  }

  if (item.type === "commandExecution" && typeof item.command === "string") {
    return item.command;
  }

  return "";
}

function normalizeItem(item: Record<string, unknown>, status: "started" | "completed"): CodexItemRecord {
  const id = typeof item.id === "string" ? item.id : crypto.randomUUID();
  return {
    id,
    type: typeof item.type === "string" ? item.type : "unknown",
    status,
    text: summarizeItem(item),
    at: Date.now(),
    raw: item
  };
}

function normalizeTurn(turn: Record<string, unknown>): CodexTurnRecord {
  const rawItems = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
  return {
    id: typeof turn.id === "string" ? turn.id : crypto.randomUUID(),
    status: typeof turn.status === "string" ? turn.status : "unknown",
    error: typeof turn.error === "string" ? turn.error : null,
    startedAt: Date.now(),
    completedAt: typeof turn.status === "string" && turn.status === "completed" ? Date.now() : null,
    items: rawItems.map((item) => normalizeItem(item, "completed"))
  };
}

export class ButlerStateStore extends EventEmitter {
  private readonly uiStatePath: string;
  private readonly threads = new Map<string, CodexThreadRecord>();
  private windows: ButlerWindow[] = [];
  private focusedWindowId: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(uiStatePath: string) {
    super();
    this.uiStatePath = uiStatePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.uiStatePath, "utf8");
      const data = JSON.parse(raw) as PersistedUiState;
      this.windows = Array.isArray(data.windows) ? data.windows : [];
      this.focusedWindowId = typeof data.focusedWindowId === "string" ? data.focusedWindowId : null;
    } catch {
      this.windows = [];
      this.focusedWindowId = null;
    }
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const payload: PersistedUiState = {
        windows: this.windows,
        focusedWindowId: this.focusedWindowId
      };
      await fs.mkdir(path.dirname(this.uiStatePath), { recursive: true });
      await fs.writeFile(this.uiStatePath, JSON.stringify(payload, null, 2));
    }, 150);
  }

  private emitChange(): void {
    this.emit("change");
  }

  private getOrCreateThread(id: string): CodexThreadRecord {
    const existing = this.threads.get(id);
    if (existing) {
      return existing;
    }

    const created: CodexThreadRecord = {
      id,
      preview: "",
      source: "unknown",
      cwd: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "unknown",
      modelProvider: null,
      turnCount: 0,
      loaded: false,
      contextUsage: emptyCodexContextUsage(),
      compaction: emptyCodexCompaction(),
      turns: [],
      eventLog: []
    };
    this.threads.set(id, created);
    return created;
  }

  upsertThreadSummary(thread: Record<string, unknown>): void {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id) {
      return;
    }

    const record = this.getOrCreateThread(id);
    record.preview = typeof thread.preview === "string" ? thread.preview : record.preview;
    record.source = typeof thread.source === "string" ? thread.source : record.source;
    record.cwd = typeof thread.cwd === "string" ? thread.cwd : record.cwd;
    record.createdAt = typeof thread.createdAt === "number" ? thread.createdAt * 1000 : record.createdAt;
    record.updatedAt = typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : record.updatedAt;
    record.status = normalizeStatus(thread.status);
    record.modelProvider = typeof thread.modelProvider === "string" ? thread.modelProvider : record.modelProvider;

    if (Array.isArray(thread.turns)) {
      record.turnCount = thread.turns.length;
      record.turns = (thread.turns as Record<string, unknown>[]).map((turn) => normalizeTurn(turn));
    } else {
      record.turnCount = Math.max(record.turnCount, record.turns.length);
    }

    this.refreshDerivedThreadState(record);
    this.emitChange();
  }

  markLoadedThreads(threadIds: string[]): void {
    const loaded = new Set(threadIds);
    for (const record of this.threads.values()) {
      record.loaded = loaded.has(record.id);
    }
    this.emitChange();
  }

  setThreadDetail(thread: Record<string, unknown>): void {
    this.upsertThreadSummary(thread);
  }

  setThreadStatus(threadId: string, status: unknown): void {
    const record = this.getOrCreateThread(threadId);
    record.status = normalizeStatus(status);
    record.updatedAt = Date.now();
    this.refreshDerivedThreadState(record);
    this.emitChange();
  }

  private getOrCreateTurn(threadId: string, turnId: string): CodexTurnRecord {
    const record = this.getOrCreateThread(threadId);
    let turn = record.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      turn = {
        id: turnId,
        status: "unknown",
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        items: []
      };
      record.turns.push(turn);
      record.turnCount = record.turns.length;
    }
    return turn;
  }

  updateTurn(threadId: string, turn: Record<string, unknown>): void {
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    if (!turnId) {
      return;
    }

    const record = this.getOrCreateThread(threadId);
    const target = this.getOrCreateTurn(threadId, turnId);
    target.status = typeof turn.status === "string" ? turn.status : target.status;
    target.error = typeof turn.error === "string" ? turn.error : null;
    if (target.status === "completed" || target.status === "failed" || target.status === "interrupted") {
      target.completedAt = Date.now();
    } else if (!target.startedAt) {
      target.startedAt = Date.now();
    }
    record.updatedAt = Date.now();
    record.turnCount = record.turns.length;
    this.refreshDerivedThreadState(record);
    this.emitChange();
  }

  updateItem(threadId: string, turnId: string, item: Record<string, unknown>, status: "started" | "completed"): void {
    const turn = this.getOrCreateTurn(threadId, turnId);
    const normalized = normalizeItem(item, status);
    const existing = turn.items.find((entry) => entry.id === normalized.id);

    if (existing) {
      existing.status = normalized.status;
      existing.text = normalized.text || existing.text;
      existing.at = Date.now();
      existing.raw = normalized.raw;
    } else {
      turn.items.push(normalized);
    }

    const thread = this.getOrCreateThread(threadId);
    thread.updatedAt = Date.now();
    thread.turnCount = thread.turns.length;
    this.refreshDerivedThreadState(thread);
    this.emitChange();
  }

  appendItemDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const turn = this.getOrCreateTurn(threadId, turnId);
    const target = turn.items.find((item) => item.id === itemId);
    if (!target) {
      turn.items.push({
        id: itemId,
        type: "agentMessage",
        status: "started",
        text: delta,
        at: Date.now(),
        raw: {}
      });
    } else {
      target.text += delta;
      target.at = Date.now();
    }

    const thread = this.getOrCreateThread(threadId);
    thread.updatedAt = Date.now();
    this.refreshDerivedThreadState(thread);
    this.emitChange();
  }

  updateThreadTokenUsage(
    threadId: string,
    tokenUsage: {
      totalTokens?: number | null;
      modelContextWindow?: number | null;
    }
  ): void {
    const thread = this.getOrCreateThread(threadId);
    const tokens = typeof tokenUsage.totalTokens === "number" ? tokenUsage.totalTokens : null;
    const contextWindow = typeof tokenUsage.modelContextWindow === "number" ? tokenUsage.modelContextWindow : null;
    thread.contextUsage = {
      tokens,
      contextWindow,
      percent: tokens !== null && contextWindow ? (tokens / contextWindow) * 100 : null
    };
    thread.updatedAt = Date.now();
    this.emitChange();
  }

  private refreshDerivedThreadState(thread: CodexThreadRecord): void {
    let count = 0;
    let active = false;
    let lastStartedAt: number | null = null;
    let lastCompletedAt: number | null = null;

    for (const turn of thread.turns) {
      const hasCompaction = turn.items.some((item) => item.type === "contextCompaction");
      if (!hasCompaction) {
        continue;
      }

      count += 1;
      lastStartedAt = Math.max(lastStartedAt ?? 0, turn.startedAt || 0) || lastStartedAt;

      if (turn.completedAt) {
        lastCompletedAt = Math.max(lastCompletedAt ?? 0, turn.completedAt) || lastCompletedAt;
      } else {
        active = true;
      }

      if (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "interrupted") {
        active = true;
      }
    }

    thread.compaction = {
      active,
      count,
      lastStartedAt,
      lastCompletedAt
    };
  }

  addEvent(threadId: string, method: string, summary: string): void {
    const thread = this.getOrCreateThread(threadId);
    const entry: CodexEventEntry = {
      at: Date.now(),
      method,
      summary
    };
    thread.eventLog.unshift(entry);
    thread.eventLog = thread.eventLog.slice(0, MAX_EVENT_LOG);
    thread.updatedAt = Date.now();
    this.emitChange();
  }

  openWindow(threadId: string): void {
    const thread = this.getOrCreateThread(threadId);
    if (!this.windows.find((window) => window.threadId === threadId)) {
      this.windows.unshift({
        threadId,
        title: thread.preview || `Job ${threadId.slice(0, 8)}`,
        openedAt: Date.now()
      });
    }
    this.focusedWindowId = threadId;
    this.queueSave();
    this.emitChange();
  }

  focusWindow(threadId: string): void {
    if (!this.windows.find((window) => window.threadId === threadId)) {
      return;
    }
    this.focusedWindowId = threadId;
    this.queueSave();
    this.emitChange();
  }

  focusButler(): void {
    this.focusedWindowId = null;
    this.queueSave();
    this.emitChange();
  }

  closeWindow(threadId: string): void {
    this.windows = this.windows.filter((window) => window.threadId !== threadId);
    if (this.focusedWindowId === threadId) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  removeThread(threadId: string): void {
    this.threads.delete(threadId);
    this.windows = this.windows.filter((window) => window.threadId !== threadId);
    if (this.focusedWindowId === threadId) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  removeThreads(threadIds: string[]): void {
    const targets = new Set(threadIds);
    if (targets.size === 0) {
      return;
    }

    for (const threadId of targets) {
      this.threads.delete(threadId);
    }

    this.windows = this.windows.filter((window) => !targets.has(window.threadId));
    if (this.focusedWindowId && targets.has(this.focusedWindowId)) {
      this.focusedWindowId = this.windows[0]?.threadId ?? null;
    }
    this.queueSave();
    this.emitChange();
  }

  listThreads(): CodexThreadSummary[] {
    return [...this.threads.values()]
      .map((thread) => ({
        id: thread.id,
        preview: thread.preview,
        source: thread.source,
        cwd: thread.cwd,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
        modelProvider: thread.modelProvider,
        turnCount: thread.turnCount,
        loaded: thread.loaded,
        contextUsage: thread.contextUsage,
        compaction: thread.compaction
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(threadId: string): CodexThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  getSnapshot(butler: {
    ready: boolean;
    pending: boolean;
    isStreaming: boolean;
    sessionId: string | null;
    model: string | null;
    auth: AppSnapshot["butler"]["auth"];
    messages: ButlerMessageView[];
    tools: AppSnapshot["butler"]["tools"];
    contextUsage: AppSnapshot["butler"]["contextUsage"];
    compaction: AppSnapshot["butler"]["compaction"];
    lastError: string | null;
    compose: AppSnapshot["butler"]["compose"];
  }, codexConnection: {
    connected: boolean;
    lastError: string | null;
    compose: AppSnapshot["codex"]["compose"];
  }): AppSnapshot {
    const openThreads = Object.fromEntries(
      this.windows
        .map((window) => {
          const thread = this.threads.get(window.threadId);
          return thread ? [window.threadId, thread] : null;
        })
        .filter((entry): entry is [string, CodexThreadRecord] => Boolean(entry))
    );

    return {
      codex: {
        connected: codexConnection.connected,
        lastError: codexConnection.lastError,
        threads: this.listThreads(),
        windows: this.windows,
        focusedWindowId: this.focusedWindowId,
        openThreads,
        compose: codexConnection.compose
      },
      butler
    };
  }
}
