import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { getJson, patchJson, postJson } from "./api";
import manorLogoLight from "./assets/manor-logo.svg";
import manorLogoDark from "./assets/manor-logo-dark.svg";
import {
  ChevronLeftIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
  WarningIcon
} from "./icons";
import { MemoryDashboard } from "./MemoryDashboard";
import { SandSpinner } from "./SandSpinner";
import { useVirtualWindow } from "./useVirtualWindow";

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
const MESSAGE_ROW = 156;
const WORKER_ROW = 132;

const VIEW_LABELS: Record<PairViewMode, string> = {
  butler: "Butler",
  worker: "Codex",
  split: "Both",
  memory: "Memory"
};

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

function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "butler") return "Butler";
  if (role === "worker") return "Codex";
  return "System";
}

function shouldShowWorkLoader(pair: PairDetail): boolean {
  return pair.butlerPending || pair.status === "butler_running" || pair.status === "worker_running";
}

function workLoaderMessage(pair: PairDetail): PairMessage {
  return {
    id: `${pair.id}:work-loader`,
    role: "butler",
    lane: "butler",
    text: "",
    at: pair.lastMessage?.at ?? pair.updatedAt,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: { kind: "work-loader" },
    pending: true
  };
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

function useAutoGrow(value: string, minHeight = 56) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    const next = Math.max(minHeight, element.scrollHeight);
    element.style.height = `${Math.min(next, 240)}px`;
  }, [value, minHeight]);
  return ref;
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

  const virtual = useVirtualWindow({ count: filtered.length, rowHeight: PAIR_LIST_ROW, overscan: 6 });
  const visible = filtered.slice(virtual.start, virtual.end);

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

      <div className="pair-list" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={filtered.length}>
        <div style={{ height: virtual.totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
            {visible.length === 0 ? (
              <div className="pair-empty">
                {search ? "No sessions match your search." : "Create your first session to get started."}
              </div>
            ) : (
              visible.map((pair) => (
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
        </div>
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
            {(["butler", "worker", "split", "memory"] as PairViewMode[]).map((mode) => (
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

function MessageList({ pair, onLoadOlder }: { pair: PairDetail; onLoadOlder: () => void }) {
  const renderedMessages = useMemo(
    () => (shouldShowWorkLoader(pair) ? [...pair.messages, workLoaderMessage(pair)] : pair.messages),
    [pair]
  );
  const messages = useDeferredValue(renderedMessages);
  const virtual = useVirtualWindow({ count: messages.length, rowHeight: MESSAGE_ROW, overscan: 8 });
  const visible = messages.slice(virtual.start, virtual.end);

  return (
    <div className="transcript" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={messages.length}>
      {pair.hasMore ? (
        <button className="button is-ghost load-more" type="button" onClick={onLoadOlder}>
          Load older
        </button>
      ) : null}
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div className="transcript-stack" style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
          {visible.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: PairDetail["messages"][number] }) {
  const role = message.role === "user" ? "user" : message.role === "worker" ? "worker" : message.role === "butler" ? "butler" : "system";
  if (message.metadata.kind === "work-loader") {
    return (
      <article className="bubble is-butler is-loader" aria-label="Butler is working">
        <span className="working-indicator" aria-live="polite">
          <span className="working-indicator-label">Butler</span>
          <SandSpinner />
        </span>
      </article>
    );
  }
  return (
    <article className={`bubble is-${role}`}>
      <header className="bubble-head">
        <span>{roleLabel(message.role)}</span>
        <time className="bubble-time">{formatTime(message.at)}</time>
      </header>
      <div className="bubble-body">{message.text}</div>
      {message.sourceThreadId ? <footer className="bubble-foot">thread {shortId(message.sourceThreadId)}</footer> : null}
    </article>
  );
}

function WorkerList({ pair, rows }: { pair: PairDetail; rows: WorkerItem[] }) {
  const virtual = useVirtualWindow({ count: rows.length, rowHeight: WORKER_ROW, overscan: 6 });
  const visible = rows.slice(virtual.start, virtual.end);
  return (
    <div className="transcript" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={rows.length}>
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div className="transcript-stack" style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
          {visible.map((row) => (
            <article key={row.id} className={`worker-item ${row.type === "worker_report" ? "is-report" : ""}`}>
              <header className="head">
                <span className="type">{row.type.replace(/_/g, " ")}</span>
                <span className="status is-idle">
                  <span className="status-dot" />
                  {row.status}
                </span>
                <time className="bubble-time">{formatTime(row.at)}</time>
              </header>
              <div className="body">{row.text}</div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function Composer({
  placeholder,
  value,
  onChange,
  onSubmit,
  busy,
  sendLabel = "Send",
  hint
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  sendLabel?: string;
  hint?: string;
}) {
  const ref = useAutoGrow(value);
  return (
    <div className="composer">
      <form
        className="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || busy) return;
          onSubmit();
        }}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (value.trim() && !busy) onSubmit();
            }
          }}
          placeholder={placeholder}
          rows={2}
        />
        <div className="composer-actions">
          <span className="composer-hint">{hint ?? "⌘ + Return to send"}</span>
          <button className="composer-send" type="submit" disabled={busy || !value.trim()}>
            {busy ? <span className="spinner" /> : <SendIcon />}
            <span>{sendLabel}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ButlerPane({
  pair,
  draft,
  busy,
  onDraft,
  onSend,
  onLoadOlder
}: {
  pair: PairDetail;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onLoadOlder: () => void;
}) {
  return (
    <section className="pane" aria-label="Butler lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Butler</h2>
          <span className="pane-sub">{pair.messages.length} messages · {shortId(pair.id)}</span>
        </div>
      </div>
      <MessageList pair={pair} onLoadOlder={onLoadOlder} />
      <Composer
        placeholder="Message Butler…"
        value={draft}
        onChange={onDraft}
        onSubmit={onSend}
        busy={busy}
        sendLabel="Send"
      />
    </section>
  );
}

function WorkerPane({
  pair,
  rows
}: {
  pair: PairDetail;
  rows: WorkerItem[];
}) {
  if (!pair.worker) {
    return (
      <section className="pane" aria-label="Codex worker lane">
        <div className="pane-head">
          <div className="pane-head-info">
            <h2>Codex worker</h2>
            <span className="pane-sub">No worker attached</span>
          </div>
        </div>
        <div className="empty-state">
          <h2>No worker attached</h2>
          <p>Butler has not delegated work from this session.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="pane" aria-label="Codex worker lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Codex · {shortId(pair.worker.threadId)}</h2>
          <span className="pane-sub">{pair.worker.status} · one worker max</span>
        </div>
      </div>
      <WorkerList pair={pair} rows={rows} />
    </section>
  );
}

export function PairShell() {
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [pair, setPair] = useState<PairDetail | null>(null);
  const [workerThread, setWorkerThread] = useState<WorkerThread | null>(null);
  const [viewMode, setViewMode] = useState<PairViewMode>("split");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

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
    void loadPairs().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const interval = window.setInterval(() => void loadPairs().catch(() => undefined), 3000);
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
    const interval = window.setInterval(() => void refresh(), 2500);
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
    const interval = window.setInterval(() => void loadWorker(pair.id).catch(() => undefined), 3500);
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
      setViewMode("split");
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

  const workerVisible = viewMode !== "butler" && (pair?.worker || viewMode === "worker");
  const butlerVisible = viewMode !== "worker";

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
        ) : viewMode === "memory" ? (
          <MemoryDashboard />
        ) : (
          <>
            <div className={`workspace-body is-${viewMode}`}>
              {butlerVisible ? (
                <ButlerPane
                  pair={pair}
                  draft={draft}
                  busy={busy}
                  onDraft={setDraft}
                  onSend={() => void sendButler()}
                  onLoadOlder={() => void loadOlder()}
                />
              ) : null}
              {viewMode === "split" ? <div className="divider" /> : null}
              {workerVisible ? (
                <WorkerPane
                  pair={pair}
                  rows={workerRows}
                />
              ) : null}
            </div>
            {error ? (
              <div className="error" role="alert">
                <WarningIcon />
                <span>{error}</span>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
