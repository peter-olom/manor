import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";

import { getJson, patchJson, postJson } from "./api";
import manorLogoLight from "./assets/manor-logo.svg";
import manorLogoDark from "./assets/manor-logo-dark.svg";
import { ButlerPane } from "./ButlerPane";
import {
  ChevronLeftIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  WarningIcon
} from "./icons";
import { MemoryDashboard } from "./MemoryDashboard";
import { TerminalPane } from "./TerminalPane";
import { useEventStream } from "./useEventStream";
import { WorkerPane } from "./WorkerPane";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type {
  PairDetail,
  PairDetailResponse,
  PairListResponse,
  PairMessage,
  PairStatus,
  PairSummary,
  PairViewMode,
  PairWorkerThreadResponse
} from "../shared/pairing";
import {
  TERMINAL_LABELS,
  TERMINAL_URLS,
  readInitialTerminalTarget,
  type TerminalTarget
} from "../shared/terminal";

type WorkerItem = {
  id: string;
  type: string;
  status: string;
  text: string;
  at: number;
};

type WorkerTurn = {
  id: string;
  status: string;
  items: WorkerItem[];
};

type WorkerThread = {
  id: string;
  status: string;
  preview?: string;
  supervisor?: { latestAgentReply?: string | null; summary?: string | null };
  turns?: WorkerTurn[];
  workerReport?: { status: string; summary: string; details: string | null; updatedAt: number } | null;
};

const PAGE_SIZE = 120;
const PAIR_LIST_ROW = 64;
const BUTLER_PATCH_THREAD_ID = "butler";

const VIEW_LABELS: Record<PairViewMode, string> = {
  butler: "Butler",
  worker: "Codex",
  split: "Both",
  memory: "Memory",
  cli: "CLI"
};

const VIEW_MODES = new Set<PairViewMode>(["butler", "worker", "split", "memory", "cli"]);

function readInitialViewMode(): PairViewMode {
  if (typeof window === "undefined") return "butler";
  const value = new URLSearchParams(window.location.search).get("view");
  return value && VIEW_MODES.has(value as PairViewMode) ? (value as PairViewMode) : "butler";
}

function syncUrlState(viewMode: PairViewMode, terminalTarget: TerminalTarget): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (viewMode === "butler") {
    url.searchParams.delete("view");
  } else {
    url.searchParams.set("view", viewMode);
  }
  if (viewMode === "cli" && terminalTarget !== "butler") {
    url.searchParams.set("terminal", terminalTarget);
  } else {
    url.searchParams.delete("terminal");
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(value: number): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatTime(value);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.split("-").at(-1) ?? value.slice(0, 8);
}

function statusLabel(status: PairStatus | null | undefined): string {
  switch (status) {
    case "butler_running":
      return "Thinking";
    case "worker_running":
      return "Working";
    case "needs_butler_review":
      return "Review";
    case "blocked":
      return "Blocked";
    case "idle":
    default:
      return "Idle";
  }
}

function flattenWorker(thread: WorkerThread | null): WorkerItem[] {
  if (!thread) return [];
  const turnItems = (thread.turns ?? []).flatMap((turn) =>
    (turn.items ?? []).map((item) => ({ ...item, id: `${turn.id}:${item.id}`, status: item.status || turn.status }))
  );
  if (thread.workerReport) {
    turnItems.push({
      id: `report:${thread.workerReport.updatedAt}`,
      type: "worker_report",
      status: thread.workerReport.status,
      text: `${thread.workerReport.summary}${thread.workerReport.details ? `\n\n${thread.workerReport.details}` : ""}`,
      at: thread.workerReport.updatedAt
    });
  }
  return turnItems.filter((item) => item.text?.trim()).sort((left, right) => left.at - right.at);
}

function Sidebar({
  pairs,
  selectedPairId,
  onSelect,
  onCreate,
  onDelete,
  search,
  onSearch
}: {
  pairs: PairSummary[];
  selectedPairId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return pairs;
    return pairs.filter((pair) => pair.title.toLowerCase().includes(query) || (pair.lastMessage?.text ?? "").toLowerCase().includes(query));
  }, [pairs, search]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <picture className="brand-logo">
            <source srcSet={manorLogoLight} media="(prefers-color-scheme: light)" />
            <img src={manorLogoDark} alt="Manor" />
          </picture>
        </div>
        <button className="icon-button is-primary" type="button" onClick={onCreate} aria-label="New session">
          <PlusIcon />
        </button>
      </div>
      <div className="brand-sub">Sessions</div>

      <div className="search">
        <span className="search-icon">
          <SearchIcon />
        </span>
        <input
          type="search"
          placeholder="Search sessions…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          aria-label="Search sessions"
        />
      </div>

      <div className="sidebar-section">
        <span>All sessions</span>
        <span>{filtered.length}</span>
      </div>

      <div className="pair-list">
        {filtered.length === 0 ? (
          <div className="pair-empty">
            {search ? "No sessions match your search." : "Create your first session to get started."}
          </div>
        ) : (
          filtered.map((pair) => (
            <PairRow
              key={pair.id}
              pair={pair}
              isActive={pair.id === selectedPairId}
              onSelect={() => onSelect(pair.id)}
              onDelete={() => onDelete(pair.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function PairRow({
  pair,
  isActive,
  onSelect,
  onDelete
}: {
  pair: PairSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`pair-item ${isActive ? "is-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={`pair-dot is-${pair.status}`} aria-hidden="true" />
      <div className="pair-title">{pair.title}</div>
      <div className="pair-preview">{pair.lastMessage?.text ?? "No messages yet"}</div>
      <div className="pair-meta">
        <span className="pair-meta-time">{formatDay(pair.updatedAt)}</span>
        <span>{pair.messageCount}</span>
      </div>
      <button
        className="icon-button pair-delete"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${pair.title}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function Topbar({
  pair,
  viewMode,
  onViewMode,
  busy,
  editingTitle,
  titleDraft,
  savingTitle,
  titleError,
  onStartEditTitle,
  onTitleDraftChange,
  onCommitTitle,
  onCancelEditTitle,
  onToggleSidebar,
  isMobileSidebarOpen
}: {
  pair: PairDetail | null;
  viewMode: PairViewMode;
  onViewMode: (mode: PairViewMode) => void;
  busy: boolean;
  editingTitle: boolean;
  titleDraft: string;
  savingTitle: boolean;
  titleError: string | null;
  onStartEditTitle: () => void;
  onTitleDraftChange: (value: string) => void;
  onCommitTitle: () => void;
  onCancelEditTitle: () => void;
  onToggleSidebar: () => void;
  isMobileSidebarOpen: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="mobile-toggle"
          type="button"
          onClick={onToggleSidebar}
          aria-label={isMobileSidebarOpen ? "Close sessions" : "Open sessions"}
        >
          {isMobileSidebarOpen ? <ChevronLeftIcon /> : <MenuIcon />}
        </button>
        <div className="topbar-title">
          {pair && editingTitle ? (
            <input
              className="title-input"
              type="text"
              value={titleDraft}
              onChange={(event) => onTitleDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onCommitTitle();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelEditTitle();
                }
              }}
              onBlur={() => onCommitTitle()}
              disabled={savingTitle}
              autoFocus
              aria-label="Session title"
              maxLength={72}
            />
          ) : (
            <button
              type="button"
              className="title-button"
              onClick={pair ? onStartEditTitle : undefined}
              disabled={!pair || busy}
              aria-label={pair ? `Rename session: ${pair.title}` : "No session selected"}
            >
              <h1 className="title-label">{pair?.title ?? "No session selected"}</h1>
              {pair ? <PencilIcon /> : null}
            </button>
          )}
          {pair ? <span className="pair-id">{shortId(pair.id)}</span> : null}
          {pair && editingTitle && titleError ? (
            <span className="title-error" role="alert">{titleError}</span>
          ) : null}
        </div>
      </div>
      <div className="topbar-right">
        {pair ? (
          <div className="segmented" role="tablist" aria-label="View mode">
            {(["butler", "worker", "split", "memory", "cli"] as PairViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={viewMode === mode}
                className={viewMode === mode ? "is-selected" : ""}
                onClick={() => onViewMode(mode)}
              >
                {VIEW_LABELS[mode]}
              </button>
            ))}
          </div>
        ) : null}
        {pair?.status ? (
          <span className={`status is-${pair.status}`}>
            <span className="status-dot" />
            {statusLabel(pair.status)}
          </span>
        ) : null}
      </div>
    </header>
  );
}

export function PairShell() {
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [pair, setPair] = useState<PairDetail | null>(null);
  const [workerThread, setWorkerThread] = useState<WorkerThread | null>(null);
  const [viewMode, setViewMode] = useState<PairViewMode>(() => readInitialViewMode());
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>(
    () => readInitialTerminalTarget(new URLSearchParams(window.location.search).get("terminal")) ?? "butler"
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [butlerPatchHandler, setButlerPatchHandler] = useState<((patch: ProviderRuntimeLivePatch) => void) | null>(null);

  useEventStream({
    onButlerPatch: (patch) => {
      if (patch.threadId !== BUTLER_PATCH_THREAD_ID) return;
      butlerPatchHandler?.(patch);
    }
  });

  const startEditTitle = useCallback(() => {
    if (!pair) return;
    setTitleDraft(pair.title);
    setTitleError(null);
    setEditingTitle(true);
  }, [pair]);

  const cancelEditTitle = useCallback(() => {
    setEditingTitle(false);
    setTitleDraft("");
    setTitleError(null);
  }, []);

  const commitTitle = useCallback(async () => {
    if (!pair) return;
    const next = titleDraft.trim();
    if (!next) {
      setTitleError("Title cannot be empty");
      return;
    }
    if (next === pair.title) {
      setEditingTitle(false);
      setTitleError(null);
      return;
    }
    setSavingTitle(true);
    setTitleError(null);
    try {
      const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(pair.id)}`, { title: next });
      setPair(payload.pair);
      setPairs((current) => current.map((entry) => (entry.id === payload.pair.id ? { ...entry, title: payload.pair.title, updatedAt: payload.pair.updatedAt } : entry)));
      setEditingTitle(false);
      setTitleDraft("");
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTitle(false);
    }
  }, [pair, titleDraft]);

  const loadPairs = useCallback(async () => {
    const payload = await getJson<PairListResponse>("/api/pairs");
    startTransition(() => {
      setPairs(payload.pairs);
      setSelectedPairId((current) => current ?? payload.pairs[0]?.id ?? null);
    });
  }, []);

  const loadPair = useCallback(async (pairId: string) => {
    const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pairId)}?limit=${PAGE_SIZE}`);
    startTransition(() => setPair(payload.pair));
  }, []);

  const loadWorker = useCallback(async (pairId: string) => {
    const payload = await getJson<PairWorkerThreadResponse>(`/api/pairs/${encodeURIComponent(pairId)}/worker-thread`);
    startTransition(() => setWorkerThread((payload.thread as WorkerThread | null) ?? null));
  }, []);

  useEffect(() => {
    syncUrlState(viewMode, terminalTarget);
  }, [terminalTarget, viewMode]);

  useEffect(() => {
    void loadPairs().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const interval = window.setInterval(() => void loadPairs().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadPairs]);

  useEffect(() => {
    if (!selectedPairId) {
      setPair(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        await loadPair(selectedPairId);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadPair, selectedPairId]);

  useEffect(() => {
    if (!pair?.worker || viewMode === "butler") {
      setWorkerThread(null);
      return;
    }
    void loadWorker(pair.id).catch(() => undefined);
    const interval = window.setInterval(() => void loadWorker(pair.id).catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadWorker, pair?.id, pair?.worker?.threadId, viewMode]);

  const workerRows = useMemo<WorkerItem[]>(() => {
    if (!pair?.worker) return [];
    const rows = flattenWorker(workerThread);
    if (rows.length > 0) return rows;
    return [
      {
        id: `task:${pair.worker.threadId}`,
        type: "assigned_task",
        status: pair.worker.status,
        text: pair.worker.task,
        at: pair.worker.startedAt
      },
      {
        id: `handoff:${pair.worker.threadId}`,
        type: "handoff_prompt",
        status: pair.worker.status,
        text: pair.worker.handoffPrompt,
        at: pair.worker.startedAt
      }
    ];
  }, [pair?.worker, workerThread]);

  async function createPair() {
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>("/api/pairs", { title: "New session" });
      await loadPairs();
      setSelectedPairId(payload.pair.id);
      setPair(payload.pair);
      setViewMode("butler");
      setMobileSidebarOpen(false);
      setEditingTitle(false);
      setTitleDraft("");
      setTitleError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deletePair(pairId: string) {
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    try {
      const response = await fetch(`/api/pairs/${encodeURIComponent(pairId)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed with ${response.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (selectedPairId === pairId) {
      setSelectedPairId(null);
      setPair(null);
      setEditingTitle(false);
      setTitleDraft("");
      setTitleError(null);
    }
    await loadPairs();
  }

  async function loadOlder() {
    if (!pair?.hasMore) return;
    const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}?before=${pair.loadedStart}&limit=${PAGE_SIZE}`);
    setPair((current) => (current && current.id === payload.pair.id ? { ...current, messages: [...payload.pair.messages, ...current.messages], loadedStart: payload.pair.loadedStart, hasMore: payload.pair.hasMore } : current));
  }

  async function sendButler() {
    if (!pair) return;
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}/messages`, { text, target: "butler" });
      setPair(payload.pair);
      setDraft("");
      await loadPairs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const onButlerPatchRef = useCallback((handler: ((patch: ProviderRuntimeLivePatch) => void) | null) => {
    setButlerPatchHandler(handler);
  }, []);

  const onThinkingLevelChange = useCallback(
    async (level: string) => {
      if (!pair) return;
      const previous = pair;
      setPair((current) => (current ? { ...current, butlerThinkingLevel: level, compose: { ...current.compose, butler: { ...current.compose.butler, thinkingLevel: level } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(pair.id)}/settings`, { target: "butler", thinkingLevel: level });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [pair]
  );

  const onCodexEffortChange = useCallback(
    async (effort: string) => {
      if (!pair) return;
      const previous = pair;
      setPair((current) => (current ? { ...current, codexEffort: effort, compose: { ...current.compose, codex: { ...current.compose.codex, effort } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(pair.id)}/settings`, { target: "codex", effort });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [pair]
  );

  const workerVisible = viewMode !== "butler" && (pair?.worker || viewMode === "worker");
  const butlerVisible = viewMode !== "worker";
  const cliVisible = viewMode === "cli";
  const selectTerminalTarget = useCallback((target: TerminalTarget) => {
    setTerminalTarget(target);
  }, []);

  return (
    <main className={`app ${mobileSidebarOpen ? "is-mobile-sidebar-open" : ""} ${pair ? "" : "is-empty"}`}>
      <Sidebar
        pairs={pairs}
        selectedPairId={selectedPairId}
        onSelect={(id) => {
          setSelectedPairId(id);
          setMobileSidebarOpen(false);
          setEditingTitle(false);
          setTitleDraft("");
          setTitleError(null);
        }}
        onCreate={createPair}
        onDelete={deletePair}
        search={search}
        onSearch={setSearch}
      />
      <section className="workspace">
        <Topbar
          pair={pair}
          viewMode={viewMode}
          onViewMode={setViewMode}
          busy={busy}
          editingTitle={editingTitle}
          titleDraft={titleDraft}
          savingTitle={savingTitle}
          titleError={titleError}
          onStartEditTitle={startEditTitle}
          onTitleDraftChange={setTitleDraft}
          onCommitTitle={() => void commitTitle()}
          onCancelEditTitle={cancelEditTitle}
          onToggleSidebar={() => setMobileSidebarOpen((open) => !open)}
          isMobileSidebarOpen={mobileSidebarOpen}
        />
        {!pair ? (
          <div className="empty-state">
            <picture className="empty-logo">
              <source srcSet={manorLogoLight} media="(prefers-color-scheme: light)" />
              <img src={manorLogoDark} alt="Manor" />
            </picture>
            <h2>Welcome to Manor</h2>
            <p>Create a new session to start a scoped conversation with one Codex worker.</p>
            <button className="button is-primary" type="button" onClick={createPair} disabled={busy}>
              <PlusIcon />
              <span>New session</span>
            </button>
          </div>
        ) : (
          <div className="workspace-views">
            <div className={`workspace-view is-conversation ${viewMode === "butler" || viewMode === "worker" || viewMode === "split" ? "is-active" : ""}`}>
              <div className={`workspace-body is-${viewMode}`}>
                {butlerVisible ? (
                  <ButlerPane
                    pair={pair}
                    draft={draft}
                    busy={busy}
                    onDraft={setDraft}
                    onSend={() => void sendButler()}
                    onLoadOlder={() => void loadOlder()}
                    onButlerPatch={onButlerPatchRef}
                    onThinkingLevelChange={(level) => void onThinkingLevelChange(level)}
                  />
                ) : null}
                {viewMode === "split" ? <div className="divider" /> : null}
                {workerVisible ? (
                  <WorkerPane
                    pair={pair}
                    rows={workerRows}
                    onCodexEffortChange={(effort) => void onCodexEffortChange(effort)}
                  />
                ) : null}
              </div>
              {error ? (
                <div className="error" role="alert">
                  <WarningIcon />
                  <span>{error}</span>
                </div>
              ) : null}
            </div>
            <div className={`workspace-view is-memory ${viewMode === "memory" ? "is-active" : ""}`}>
              <MemoryDashboard />
            </div>
            <TerminalPane
              active={cliVisible}
              target={terminalTarget}
              onTarget={selectTerminalTarget}
              labels={TERMINAL_LABELS}
              urls={TERMINAL_URLS}
            />
          </div>
        )}
      </section>
    </main>
  );
}

export type { PairMessage };
