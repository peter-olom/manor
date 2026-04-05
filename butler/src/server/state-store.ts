import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AppSnapshot,
  ButlerSupervisorSummaryView,
  ButlerMessageView,
  ButlerWindow,
  CodexCompactionView,
  CodexContextUsageView,
  CodexEventEntry,
  CodexItemRecord,
  CodexMilestoneEntry,
  CodexProjectSummaryView,
  CodexThreadRecord,
  CodexThreadStatus,
  CodexThreadSummary,
  CodexThreadSupervisorView,
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

function emptyThreadSupervisor(): CodexThreadSupervisorView {
  return {
    projectId: "unknown",
    projectLabel: "Unknown",
    latestUserPrompt: null,
    latestAgentReply: null,
    summary: "No supervisor summary yet.",
    blocked: false
  };
}

function clipText(value: string | null | undefined, max = 160): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function getProjectInfo(cwd: string | null): { id: string; label: string } {
  if (!cwd) {
    return { id: "unknown", label: "Unknown" };
  }

  const normalized = cwd.replace(/\\/g, "/");
  if (!normalized.startsWith("/repos")) {
    return { id: normalized, label: normalized };
  }

  const relative = normalized.replace(/^\/repos\/?/, "");
  const [firstSegment] = relative.split("/").filter(Boolean);
  if (!firstSegment) {
    return { id: "repos", label: "repos" };
  }

  return { id: firstSegment, label: firstSegment };
}

function buildThreadSupervisor(thread: CodexThreadRecord): CodexThreadSupervisorView {
  const project = getProjectInfo(thread.cwd);
  const flattenedItems = thread.turns.flatMap((turn) => turn.items.map((item) => ({ turn, item })));
  const latestUserPrompt = clipText(
    [...flattenedItems]
      .reverse()
      .find(({ item }) => item.type === "userMessage" && item.text.trim())?.item.text ?? null
  );
  const latestAgentReply = clipText(
    [...flattenedItems]
      .reverse()
      .find(({ item }) => item.type === "agentMessage" && item.text.trim())?.item.text ?? null
  );
  const latestTurn = thread.turns.at(-1) ?? null;
  const blocked =
    Boolean(latestTurn?.error) ||
    latestTurn?.status === "failed" ||
    latestTurn?.status === "interrupted" ||
    thread.eventLog.some((entry) => /error|failed|interrupted/i.test(entry.method) || /error|failed|interrupted/i.test(entry.summary));

  let summary = "No supervisor summary yet.";
  if (blocked) {
    summary = latestTurn?.error
      ? `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}. Error: ${clipText(latestTurn.error, 120)}`
      : `Blocked after ${latestUserPrompt ? `"${latestUserPrompt}"` : "the latest prompt"}.`;
  } else if (thread.status === "active") {
    summary = latestUserPrompt
      ? `Working on "${latestUserPrompt}".`
      : thread.preview
        ? `Working on ${clipText(thread.preview, 120)}.`
        : "Work is in progress.";
  } else if (latestAgentReply) {
    summary = latestUserPrompt
      ? `Idle after "${latestUserPrompt}". Latest result: ${clipText(latestAgentReply, 120)}`
      : `Idle. Latest result: ${clipText(latestAgentReply, 120)}`;
  } else if (thread.preview) {
    summary = `Idle. Preview: ${clipText(thread.preview, 120)}`;
  } else if (thread.turnCount > 0) {
    summary = "Idle with prior activity.";
  }

  return {
    projectId: project.id,
    projectLabel: project.label,
    latestUserPrompt,
    latestAgentReply,
    summary,
    blocked
  };
}

function buildProjectSummary(threads: CodexThreadRecord[]): CodexProjectSummaryView[] {
  const grouped = new Map<string, CodexThreadRecord[]>();

  for (const thread of threads) {
    const group = grouped.get(thread.supervisor.projectId) ?? [];
    group.push(thread);
    grouped.set(thread.supervisor.projectId, group);
  }

  return [...grouped.entries()]
    .map(([id, projectThreads]) => {
      const sorted = [...projectThreads].sort((a, b) => b.updatedAt - a.updatedAt);
      const activeCount = sorted.filter((thread) => thread.status === "active").length;
      const blockedCount = sorted.filter((thread) => thread.supervisor.blocked).length;
      const completedCount = sorted.filter((thread) => thread.status === "idle" && !thread.supervisor.blocked).length;
      const lead = sorted[0];
      const statusBits = [
        activeCount > 0 ? `${activeCount} active` : null,
        blockedCount > 0 ? `${blockedCount} blocked` : null,
        completedCount > 0 ? `${completedCount} idle` : null
      ].filter(Boolean);

      return {
        id,
        label: lead?.supervisor.projectLabel ?? id,
        threadCount: sorted.length,
        activeCount,
        blockedCount,
        completedCount,
        updatedAt: lead?.updatedAt ?? Date.now(),
        summary: `${statusBits.length > 0 ? `${statusBits.join(", ")}.` : "No active work."} Latest: ${lead?.supervisor.summary ?? "No supervisor summary yet."}`,
        threadIds: sorted.map((thread) => thread.id)
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildSupervisorSummary(projects: CodexProjectSummaryView[], threads: CodexThreadRecord[]): ButlerSupervisorSummaryView {
  const activeThreads = threads.filter((thread) => thread.status === "active").length;
  const blockedThreads = threads.filter((thread) => thread.supervisor.blocked).length;
  const completedThreads = threads.filter((thread) => thread.status === "idle" && !thread.supervisor.blocked).length;
  const leadProject = projects[0];

  return {
    totalThreads: threads.length,
    activeThreads,
    blockedThreads,
    completedThreads,
    projectCount: projects.length,
    updatedAt: leadProject?.updatedAt ?? Date.now(),
    summary:
      threads.length === 0
        ? "No Codex workstreams are active yet."
        : `${activeThreads} active, ${blockedThreads} blocked, ${completedThreads} idle across ${projects.length} project${projects.length === 1 ? "" : "s"}. ${leadProject ? `Most recent project: ${leadProject.label}.` : ""}`.trim()
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
  private readonly latestStartedTurnIds = new Map<string, string>();
  private readonly latestCompletedTurnIds = new Map<string, string>();
  private readonly latestBlockedTurnIds = new Map<string, string>();
  private milestonesEnabled = false;

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
      supervisor: emptyThreadSupervisor(),
      turns: [],
      eventLog: [],
      milestones: []
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

  enableMilestones(): void {
    this.latestStartedTurnIds.clear();
    this.latestCompletedTurnIds.clear();
    this.latestBlockedTurnIds.clear();

    for (const thread of this.threads.values()) {
      const latestTurn = thread.turns.at(-1);
      if (!latestTurn) {
        continue;
      }

      this.latestStartedTurnIds.set(thread.id, latestTurn.id);
      if (latestTurn.status === "completed") {
        this.latestCompletedTurnIds.set(thread.id, latestTurn.id);
      }
      if (latestTurn.status === "failed" || latestTurn.status === "interrupted" || latestTurn.error) {
        this.latestBlockedTurnIds.set(thread.id, latestTurn.id);
      }
    }

    this.milestonesEnabled = true;
  }

  private primeThreadMilestones(threadId: string): void {
    const thread = this.threads.get(threadId);
    const latestTurn = thread?.turns.at(-1);
    if (!latestTurn) {
      return;
    }

    this.latestStartedTurnIds.set(threadId, latestTurn.id);
    if (latestTurn.status === "completed") {
      this.latestCompletedTurnIds.set(threadId, latestTurn.id);
    }
    if (latestTurn.status === "failed" || latestTurn.status === "interrupted" || latestTurn.error) {
      this.latestBlockedTurnIds.set(threadId, latestTurn.id);
    }
  }

  setThreadDetail(thread: Record<string, unknown>): void {
    const threadId = typeof thread.id === "string" ? thread.id : null;
    const wasEnabled = this.milestonesEnabled;
    this.milestonesEnabled = false;
    this.upsertThreadSummary(thread);
    if (threadId) {
      this.getOrCreateThread(threadId).loaded = true;
    }
    this.milestonesEnabled = wasEnabled;
    if (threadId) {
      this.primeThreadMilestones(threadId);
    }
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
    this.refreshDerivedThreadState(thread);
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
    thread.supervisor = buildThreadSupervisor(thread);
    this.captureMilestones(thread);
  }

  private pushMilestone(thread: CodexThreadRecord, type: CodexMilestoneEntry["type"], summary: string): void {
    const entry: CodexMilestoneEntry = {
      id: `${thread.id}:${type}:${Date.now()}`,
      at: Date.now(),
      type,
      threadId: thread.id,
      projectId: thread.supervisor.projectId,
      summary
    };
    thread.milestones.unshift(entry);
    thread.milestones = thread.milestones.slice(0, 20);
  }

  private captureMilestones(thread: CodexThreadRecord): void {
    if (!this.milestonesEnabled) {
      return;
    }

    const latestTurn = thread.turns.at(-1);
    if (!latestTurn) {
      return;
    }

    if (thread.supervisor.blocked) {
      const knownBlockedTurnId = this.latestBlockedTurnIds.get(thread.id);
      if (latestTurn.id !== knownBlockedTurnId) {
        this.latestBlockedTurnIds.set(thread.id, latestTurn.id);
        this.pushMilestone(thread, "blocked", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
      }
      return;
    }

    if (latestTurn.status === "completed") {
      const knownCompletedTurnId = this.latestCompletedTurnIds.get(thread.id);
      if (latestTurn.id !== knownCompletedTurnId) {
        this.latestCompletedTurnIds.set(thread.id, latestTurn.id);
        this.pushMilestone(thread, "completed", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
      }
      return;
    }

    const knownStartedTurnId = this.latestStartedTurnIds.get(thread.id);
    if (latestTurn.id !== knownStartedTurnId && thread.status === "active") {
      this.latestStartedTurnIds.set(thread.id, latestTurn.id);
      this.pushMilestone(thread, "started", `${thread.supervisor.projectLabel}: ${thread.supervisor.summary}`);
    }
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
    this.latestStartedTurnIds.delete(threadId);
    this.latestCompletedTurnIds.delete(threadId);
    this.latestBlockedTurnIds.delete(threadId);
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
      this.latestStartedTurnIds.delete(threadId);
      this.latestCompletedTurnIds.delete(threadId);
      this.latestBlockedTurnIds.delete(threadId);
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
        compaction: thread.compaction,
        supervisor: thread.supervisor
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(threadId: string): CodexThreadRecord | undefined {
    return this.threads.get(threadId);
  }

  getOpenWindowIds(): string[] {
    return this.windows.map((window) => window.threadId);
  }

  listProjectSummaries(): CodexProjectSummaryView[] {
    return buildProjectSummary([...this.threads.values()]);
  }

  getProjectSummary(projectId: string): CodexProjectSummaryView | undefined {
    return this.listProjectSummaries().find((project) => project.id === projectId);
  }

  getSupervisorSummary(): ButlerSupervisorSummaryView {
    const threads = [...this.threads.values()];
    return buildSupervisorSummary(buildProjectSummary(threads), threads);
  }

  listMilestones(): CodexMilestoneEntry[] {
    return [...this.threads.values()]
      .flatMap((thread) => thread.milestones)
      .sort((a, b) => b.at - a.at);
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
    onboarding: AppSnapshot["butler"]["onboarding"];
    contextUsage: AppSnapshot["butler"]["contextUsage"];
    compaction: AppSnapshot["butler"]["compaction"];
    supervision: AppSnapshot["butler"]["supervision"];
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
      butler: {
        ...butler,
        supervision: {
          ...butler.supervision,
          projects: this.listProjectSummaries(),
          supervisor: this.getSupervisorSummary()
        }
      }
    };
  }
}
