import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";

import { getJson, patchJson, postJson, type FileReference } from "./api";
import manorLogoLight from "./assets/manor-logo.svg";
import manorLogoDark from "./assets/manor-logo-dark.svg";
import { ButlerPane } from "./ButlerPane";
import {
  ChevronLeftIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SetupTabIcon,
  StatusIcon,
  ThreadsIcon,
  TrashIcon,
  WarningIcon
} from "./icons";
import { MemoryDashboard, type MemoryDashboardSummary, type MemoryProjectOption } from "./MemoryDashboard";
import { ImagePreviewModal, type PreviewMedia } from "./ImagePreviewModal";
import { SandSpinner } from "./SandSpinner";
import {
  SelfImprovementQueue,
  formatSelfImprovementTime,
  selfImprovementStatusLabel
} from "./SelfImprovementQueue";
import { TerminalPane } from "./TerminalPane";
import { useEventStream } from "./useEventStream";
import { WorkerPane } from "./WorkerPane";
import type { WorkerChecklistItem, WorkerItem, WorkerJobPayload, WorkerProofRecord, WorkerTimeline, WorkerTurnGroup } from "./WorkerPane";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type { MemorySection } from "../shared/memory";
import type { SelfImprovementQueueResponse, SelfImprovementRequestView } from "../shared/self-improvement";
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

type WorkerThread = {
  id: string;
  status: string;
  preview?: string;
  supervisor?: { latestAgentReply?: string | null; summary?: string | null };
  turns?: {
    id: string;
    status: string;
    startedAt?: number;
    completedAt?: number | null;
    items: WorkerItem[];
  }[];
  workerReport?: WorkerThreadReport | null;
  workerReports?: WorkerThreadReport[];
  jobPayload?: WorkerJobPayload | null;
  supervisionChecklist?: {
    items?: Array<{ id: string; text: string; status: string; butlerNote?: string | null; queuedInstruction?: string | null }>;
  } | null;
};

type WorkerThreadReport = {
  turnId: string;
  status: string;
  summary: string;
  details: string | null;
  evidence?: Array<{ proofRunId?: string | null; artifactId?: string | null }>;
  claims?: {
    claims?: Array<{ proofId?: string | null }>;
  } | null;
  createdAt?: number;
  updatedAt: number;
};

type RuntimeProofSnapshot = {
  previewProofsByThreadId?: Record<string, WorkerProofRecord[]>;
};

const PAGE_SIZE = 120;
const PAIR_LIST_ROW = 64;
const BUTLER_PATCH_THREAD_ID = "butler";

const VIEW_LABELS: Record<PairViewMode, string> = {
  butler: "Butler",
  worker: "Codex",
  split: "Both",
  memory: "Memory",
  improve: "Improve",
  cli: "CLI"
};

const VIEW_MODES = new Set<PairViewMode>(["butler", "worker", "split", "memory", "improve", "cli"]);
type WorkstreamViewMode = Exclude<PairViewMode, "memory" | "improve">;
type ManorSurface = "sessions" | "memory" | "improve";
const WORKSTREAM_MODES: WorkstreamViewMode[] = ["butler", "worker", "split", "cli"];

function manorSurfaceForView(viewMode: PairViewMode): ManorSurface {
  if (viewMode === "memory" || viewMode === "improve") return viewMode;
  return "sessions";
}

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

function workerReportFromWire(report: WorkerThreadReport): WorkerTimeline["reports"][number] {
  return {
    turnId: report.turnId,
    status: report.status,
    summary: report.summary,
    details: report.details,
    evidence: report.evidence,
    claims: report.claims,
    updatedAt: report.updatedAt
  };
}

function shapeWorkerTimeline(thread: WorkerThread | null): WorkerTimeline {
  if (!thread) return { turns: [], report: null, reports: [], payload: null, checklist: null, fallback: [] };
  const checklist: WorkerChecklistItem[] | null = thread.supervisionChecklist?.items?.length
    ? thread.supervisionChecklist.items.map((item) => ({
        id: item.id,
        text: item.text,
        status: item.status,
        note: item.butlerNote ?? item.queuedInstruction ?? null
      }))
    : null;
  const reportsByTurnId = new Map<string, WorkerTimeline["reports"][number]>();
  for (const rawReport of thread.workerReports ?? []) {
    const report = workerReportFromWire(rawReport);
    if (report.turnId) reportsByTurnId.set(report.turnId, report);
  }
  if (thread.workerReport) {
    const report = workerReportFromWire(thread.workerReport);
    if (report.turnId) reportsByTurnId.set(report.turnId, report);
  }
  const reports = [...reportsByTurnId.values()].sort((left, right) => left.updatedAt - right.updatedAt);
  const report = reports.at(-1) ?? null;
  const turns: WorkerTurnGroup[] = (thread.turns ?? [])
    .map((turn) => {
      const items = (turn.items ?? [])
        .map((item) => ({ ...item, id: `${turn.id}:${item.id}`, status: item.status || turn.status }))
        .filter((item) => item.text?.trim());
      const turnReport = reportsByTurnId.get(turn.id) ?? null;
      if (turnReport) {
        items.push({
          id: `${turn.id}:worker-report:${turnReport.updatedAt}`,
          type: "assistant_message",
          status: "completed",
          text: `${turnReport.summary}${turnReport.details ? `\n\n${turnReport.details}` : ""}`,
          at: turnReport.updatedAt
        });
      }
      items.sort((left, right) => left.at - right.at);
      const completedAt = turn.completedAt ?? null;
      let finalIndex: number | null = null;
      if (completedAt !== null) {
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (items[i]?.type === "agentMessage" || items[i]?.type === "assistant_message") {
            finalIndex = i;
            break;
          }
        }
      }
      return {
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt ?? items[0]?.at ?? 0,
        completedAt,
        items,
        finalIndex
      };
    })
    .filter((turn) => turn.items.length > 0 || turn.completedAt === null);
  return {
    turns,
    report: report && !turns.some((turn) => turn.id === report.turnId) ? report : null,
    reports,
    payload: thread.jobPayload ?? null,
    checklist,
    fallback: []
  };
}

function Sidebar({
  pairs,
  selectedPairId,
  manorSurface,
  improvePendingCount,
  improveQueue,
  selectedImproveRequestId,
  memorySection,
  memorySummary,
  onSelect,
  onSelectManor,
  onSelectImproveRequest,
  onSelectMemorySection,
  onCreate,
  onDelete,
  search,
  onSearch
}: {
  pairs: PairSummary[];
  selectedPairId: string | null;
  manorSurface: ManorSurface;
  improvePendingCount: number;
  improveQueue: SelfImprovementQueueResponse | null;
  selectedImproveRequestId: string | null;
  memorySection: MemorySection;
  memorySummary: MemoryDashboardSummary | null;
  onSelect: (id: string) => void;
  onSelectManor: (surface: ManorSurface) => void;
  onSelectImproveRequest: (id: string) => void;
  onSelectMemorySection: (section: MemorySection) => void;
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
  const improveRequests = improveQueue?.requests ?? [];
  const selectedImproveRequest =
    improveRequests.find((request) => request.id === selectedImproveRequestId) ?? improveRequests[0] ?? null;

  return (
    <aside className={`sidebar ${manorSurface === "sessions" ? "" : "is-surface-only"}`}>
      <div className="sidebar-head">
        <div className="brand">
          <picture className="brand-logo">
            <source srcSet={manorLogoLight} media="(prefers-color-scheme: light)" />
            <img src={manorLogoDark} alt="Manor" />
          </picture>
        </div>
      </div>

      <div className="sidebar-switcher">
        <nav className="sidebar-nav" aria-label="Manor">
          <button
            className={`sidebar-nav-item ${manorSurface === "sessions" ? "is-selected" : ""}`}
            type="button"
            aria-label="Sessions"
            aria-current={manorSurface === "sessions" ? "page" : undefined}
            onClick={() => onSelectManor("sessions")}
            title="Sessions"
          >
            <ThreadsIcon />
            <span>Sessions</span>
          </button>
          <button
            className={`sidebar-nav-item ${manorSurface === "memory" ? "is-selected" : ""}`}
            type="button"
            aria-label="Memory"
            aria-current={manorSurface === "memory" ? "page" : undefined}
            onClick={() => onSelectManor("memory")}
            title="Memory"
          >
            <StatusIcon kind="context" />
            <span>Memory</span>
          </button>
          <button
            className={`sidebar-nav-item ${manorSurface === "improve" ? "is-selected" : ""}`}
            type="button"
            aria-label={improvePendingCount > 0 ? `Improve, ${improvePendingCount} pending` : "Improve"}
            aria-current={manorSurface === "improve" ? "page" : undefined}
            onClick={() => onSelectManor("improve")}
            title="Improve"
          >
            <SetupTabIcon />
            <span>Improve</span>
            {improvePendingCount > 0 ? <span className="sidebar-nav-badge">{improvePendingCount}</span> : null}
          </button>
        </nav>
      </div>
      <div className="sidebar-divider" aria-hidden="true" />

      {manorSurface === "sessions" ? (
        <>
          <div className="sidebar-surface-head">
            <div className="sidebar-surface-title">
              <span className="sidebar-surface-label">Sessions</span>
              <span className="sidebar-surface-count">{filtered.length}</span>
            </div>
            <button className="icon-button is-primary" type="button" onClick={onCreate} aria-label="New session">
              <PlusIcon />
            </button>
          </div>

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
        </>
      ) : null}
      {manorSurface === "memory" ? (
        <>
          <div className="sidebar-surface-head">
            <div className="sidebar-surface-title">
              <span className="sidebar-surface-label">Memory</span>
              <span className="sidebar-surface-count">{memorySummary?.totalCount ?? 0}</span>
            </div>
          </div>
          <div className="sidebar-surface-list" aria-label="Memory sections">
            {(["projects", "jobs", "butler"] as MemorySection[]).map((sectionOption) => {
              const count = memorySummary?.counts[sectionOption]?.total ?? 0;
              const label = sectionOption === "projects" ? "Projects" : sectionOption === "jobs" ? "Jobs" : "Butler";
              const description =
                sectionOption === "projects"
                  ? "Project memory"
                  : sectionOption === "jobs"
                    ? "Job memory"
                    : "Global memory";
              return (
                <button
                  key={sectionOption}
                  type="button"
                  className={`sidebar-surface-item ${memorySection === sectionOption ? "is-active" : ""}`}
                  onClick={() => onSelectMemorySection(sectionOption)}
                >
                  <span className="sidebar-surface-item-title">{label}</span>
                  <span className="sidebar-surface-item-preview">{description}</span>
                  <span className="sidebar-surface-item-meta">{count}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {manorSurface === "improve" ? (
        <>
          <div className="sidebar-surface-head">
            <div className="sidebar-surface-title">
              <span className="sidebar-surface-label">Requests</span>
              <span className="sidebar-surface-count">{improveRequests.length}</span>
            </div>
          </div>
          <div className="sidebar-improve-list" aria-label="Self-improvement requests">
            {improveRequests.length === 0 ? (
              <div className="pair-empty">No requests.</div>
            ) : (
              improveRequests.map((request) => (
                <button
                  key={request.id}
                  type="button"
                  className={`improve-item ${request.id === selectedImproveRequest?.id ? "is-active" : ""}`}
                  onClick={() => onSelectImproveRequest(request.id)}
                >
                  <span className={`improve-status is-${request.status}`}>{selfImprovementStatusLabel(request.status)}</span>
                  <strong>{request.trigger}</strong>
                  <span>{request.sourceProjectLabel ?? request.sourceThreadId ?? "Manor"}</span>
                  <time>{formatSelfImprovementTime(request.updatedAt)}</time>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}
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
  workstreamMode,
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
  isMobileSidebarOpen,
  improveRequestCount,
  improveEligibilityBlocked,
  improveEligibilityMode,
  memorySection,
  memorySearch,
  memoryProjectFilter,
  memoryProjectOptions,
  memoryActiveCount,
  memoryTotalCount,
  onMemorySearch,
  onMemoryProjectFilter
}: {
  pair: PairDetail | null;
  viewMode: PairViewMode;
  workstreamMode: WorkstreamViewMode;
  onViewMode: (mode: WorkstreamViewMode) => void;
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
  improveRequestCount: number;
  improveEligibilityBlocked: boolean;
  improveEligibilityMode: string | null;
  memorySection: MemorySection;
  memorySearch: string;
  memoryProjectFilter: string;
  memoryProjectOptions: MemoryProjectOption[];
  memoryActiveCount: number;
  memoryTotalCount: number;
  onMemorySearch: (value: string) => void;
  onMemoryProjectFilter: (value: string) => void;
}) {
  const isGlobalSurface = viewMode === "memory" || viewMode === "improve";
  const surfaceTitle = viewMode === "memory" ? "Memory" : viewMode === "improve" ? "Self-improvement" : null;
  const surfaceMeta =
    viewMode === "memory"
      ? `${memoryActiveCount} of ${memoryTotalCount} ${memorySection}`
      : viewMode === "improve"
      ? `${improveRequestCount} requests`
      : null;
  const modes: WorkstreamViewMode[] = pair ? WORKSTREAM_MODES : ["cli"];
  return (
    <header className={`topbar ${isGlobalSurface ? "is-global-surface" : ""}`}>
      <div className="topbar-left">
        <button
          className="mobile-toggle"
          type="button"
          onClick={onToggleSidebar}
          aria-label={isMobileSidebarOpen ? "Close navigation" : "Open navigation"}
        >
          {isMobileSidebarOpen ? <ChevronLeftIcon /> : <MenuIcon />}
        </button>
        <div className="topbar-title">
          {isGlobalSurface ? (
            <div className="surface-topbar-title">
              <h1 className="title-label">{surfaceTitle}</h1>
              {surfaceMeta ? <span className="surface-topbar-meta">{surfaceMeta}</span> : null}
            </div>
          ) : pair && editingTitle ? (
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
          {pair?.status === "worker_running" && !isGlobalSurface ? (
            <span className="topbar-worker-loader" aria-label="Codex is working">
              <SandSpinner />
            </span>
          ) : null}
          {pair && !isGlobalSurface ? <span className="pair-id">{shortId(pair.id)}</span> : null}
          {pair && !isGlobalSurface && editingTitle && titleError ? (
            <span className="title-error" role="alert">{titleError}</span>
          ) : null}
        </div>
      </div>
      <div className="topbar-right">
        {viewMode === "memory" ? (
          <div className="topbar-memory-controls">
            <div className="search dashboard-search">
              <span className="search-icon">
                <SearchIcon />
              </span>
              <input
                type="search"
                placeholder={`Search ${memorySection}…`}
                value={memorySearch}
                onChange={(event) => onMemorySearch(event.target.value)}
                aria-label={`Search ${memorySection}`}
              />
            </div>
            <select
              className="dashboard-project-filter"
              value={memoryProjectFilter}
              onChange={(event) => onMemoryProjectFilter(event.target.value)}
              aria-label="Filter by project"
              disabled={memorySection === "butler"}
            >
              <option value="">{memorySection === "butler" ? "Global" : "All projects"}</option>
              {memoryProjectOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {viewMode === "improve" && improveEligibilityBlocked ? (
          <span className="improve-gate">
            <WarningIcon />
            {improveEligibilityMode === "image" ? "Image mode" : "Disabled"}
          </span>
        ) : null}
        {!isGlobalSurface ? (
          <div className="segmented" role="tablist" aria-label="View mode">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={workstreamMode === mode}
                className={workstreamMode === mode ? "is-selected" : ""}
                onClick={() => onViewMode(mode)}
              >
                {VIEW_LABELS[mode]}
              </button>
            ))}
          </div>
        ) : null}
        {pair?.status && !isGlobalSurface ? (
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
  const [workerThreadPairId, setWorkerThreadPairId] = useState<string | null>(null);
  const [workerThreadLoading, setWorkerThreadLoading] = useState(false);
  const [viewMode, setViewMode] = useState<PairViewMode>(() => readInitialViewMode());
  const [lastWorkstreamMode, setLastWorkstreamMode] = useState<WorkstreamViewMode>(() => {
    const initial = readInitialViewMode();
    return initial === "memory" || initial === "improve" ? "butler" : initial;
  });
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
  const [improvePendingCount, setImprovePendingCount] = useState(0);
  const [improveQueue, setImproveQueue] = useState<SelfImprovementQueueResponse | null>(null);
  const [selectedImproveRequestId, setSelectedImproveRequestId] = useState<string | null>(null);
  const [memorySection, setMemorySection] = useState<MemorySection>("projects");
  const [memorySearch, setMemorySearch] = useState("");
  const [memoryProjectFilter, setMemoryProjectFilter] = useState("");
  const [memorySummary, setMemorySummary] = useState<MemoryDashboardSummary | null>(null);
  const [proofsByThreadId, setProofsByThreadId] = useState<Record<string, WorkerProofRecord[]>>({});
  const [composerAttachments, setComposerAttachments] = useState<FileReference[]>([]);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const manorSurface = manorSurfaceForView(viewMode);
  const activePair = pair?.id === selectedPairId ? pair : null;
  const shouldLoadWorkerThread = manorSurface === "sessions" && viewMode !== "butler" && Boolean(activePair?.worker);
  const activeWorkerPairId = shouldLoadWorkerThread ? activePair?.id ?? null : null;
  const activeWorkerThreadId = shouldLoadWorkerThread ? activePair?.worker?.threadId ?? null : null;
  const activeWorkerThread = workerThreadPairId === activeWorkerPairId ? workerThread : null;
  const activeWorkerThreadLoading = Boolean(activeWorkerPairId && (workerThreadPairId !== activeWorkerPairId || workerThreadLoading));

  const applyRuntimeSnapshot = useCallback((runtime: unknown) => {
    const typed = runtime as RuntimeProofSnapshot | null;
    if (!typed || typeof typed !== "object" || !typed.previewProofsByThreadId) return;
    setProofsByThreadId(typed.previewProofsByThreadId);
  }, []);

  useEventStream({
    onButlerPatch: (patch) => {
      if (patch.threadId !== BUTLER_PATCH_THREAD_ID) return;
      butlerPatchHandler?.(patch);
    },
    onComposerPrefill: (payload) => {
      if (!activePair) return;
      if (payload.target.kind === "thread" && payload.target.threadId !== activePair.worker?.threadId) return;
      setDraft((current) => {
        const next = payload.text.trim();
        if (!next) return current;
        return current.trim() ? `${current.trimEnd()}\n\n${next}` : next;
      });
      if (payload.attachment) {
        setComposerAttachments((current) =>
          current.some((entry) => entry.id === payload.attachment!.id) ? current : [...current, payload.attachment!]
        );
      }
      if (viewMode === "worker") {
        setViewMode("split");
      } else if (manorSurface !== "sessions") {
        setViewMode("butler");
      }
    },
    onInitial: (payload) => {
      if (payload.runtime) applyRuntimeSnapshot(payload.runtime);
    }
  });

  const startEditTitle = useCallback(() => {
    if (!activePair) return;
    setTitleDraft(activePair.title);
    setTitleError(null);
    setEditingTitle(true);
  }, [activePair]);

  const cancelEditTitle = useCallback(() => {
    setEditingTitle(false);
    setTitleDraft("");
    setTitleError(null);
  }, []);

  const commitTitle = useCallback(async () => {
    if (!activePair) return;
    const next = titleDraft.trim();
    if (!next) {
      setTitleError("Title cannot be empty");
      return;
    }
    if (next === activePair.title) {
      setEditingTitle(false);
      setTitleError(null);
      return;
    }
    const previous = activePair;
    setSavingTitle(true);
    setTitleError(null);
    try {
      const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}`, { title: next });
      setPair(payload.pair);
      setPairs((current) => current.map((entry) => (entry.id === payload.pair.id ? { ...entry, title: payload.pair.title, updatedAt: payload.pair.updatedAt } : entry)));
      setEditingTitle(false);
      setTitleDraft("");
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : String(err));
      setPair(previous);
    } finally {
      setSavingTitle(false);
    }
  }, [activePair, titleDraft]);

  const loadPairs = useCallback(async () => {
    const payload = await getJson<PairListResponse>("/api/pairs");
    startTransition(() => {
      setPairs(payload.pairs);
      setSelectedPairId((current) => current ?? payload.pairs[0]?.id ?? null);
    });
  }, []);

  const loadWorker = useCallback(async (pairId: string): Promise<WorkerThread | null> => {
    const payload = await getJson<PairWorkerThreadResponse>(`/api/pairs/${encodeURIComponent(pairId)}/worker-thread`);
    return (payload.thread as WorkerThread | null) ?? null;
  }, []);

  useEffect(() => {
    syncUrlState(viewMode, terminalTarget);
  }, [terminalTarget, viewMode]);

  useEffect(() => {
    if (viewMode !== "memory" && viewMode !== "improve") setLastWorkstreamMode(viewMode);
  }, [viewMode]);

  useEffect(() => {
    void loadPairs().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const interval = window.setInterval(() => void loadPairs().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadPairs]);

  const loadImproveQueue = useCallback(async () => {
    const payload = await getJson<SelfImprovementQueueResponse>("/api/self-improvement/requests");
    startTransition(() => {
      setImproveQueue(payload);
      setImprovePendingCount(payload.requests.filter((request) => request.status === "pending").length);
      setSelectedImproveRequestId((current) =>
        current && payload.requests.some((request) => request.id === current) ? current : payload.requests[0]?.id ?? null
      );
    });
  }, []);

  useEffect(() => {
    void loadImproveQueue().catch(() => undefined);
    const interval = window.setInterval(() => void loadImproveQueue().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadImproveQueue]);

  const loadRuntime = useCallback(async () => {
    const payload = await getJson<RuntimeProofSnapshot>("/api/runtime");
    startTransition(() => applyRuntimeSnapshot(payload));
  }, [applyRuntimeSnapshot]);

  useEffect(() => {
    void loadRuntime().catch(() => undefined);
    const interval = window.setInterval(() => void loadRuntime().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadRuntime]);

  useEffect(() => {
    if (!selectedPairId) {
      setPair(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(selectedPairId)}?limit=${PAGE_SIZE}`);
        if (!cancelled) {
          startTransition(() => setPair(payload.pair));
        }
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
  }, [selectedPairId]);

  useEffect(() => {
    if (!activeWorkerPairId) {
      setWorkerThread(null);
      setWorkerThreadPairId(null);
      setWorkerThreadLoading(false);
      return;
    }
    let cancelled = false;
    const pairId = activeWorkerPairId;
    setWorkerThread(null);
    setWorkerThreadPairId(pairId);
    setWorkerThreadLoading(true);
    const refresh = async () => {
      try {
        const thread = await loadWorker(pairId);
        if (!cancelled) {
          startTransition(() => {
            setWorkerThread(thread);
            setWorkerThreadPairId(pairId);
            setWorkerThreadLoading(false);
          });
        }
      } catch {
        if (!cancelled) {
          setWorkerThreadLoading(false);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkerPairId, activeWorkerThreadId, loadWorker]);

  const workerTimeline = useMemo<WorkerTimeline>(() => {
    if (!activePair?.worker) return { turns: [], report: null, reports: [], payload: null, checklist: null, fallback: [] };
    const timeline = shapeWorkerTimeline(activeWorkerThread);
    if (activeWorkerThreadLoading || timeline.turns.length > 0 || timeline.report) return timeline;
    return {
      turns: [],
      report: null,
      reports: timeline.reports,
      payload: null,
      checklist: timeline.checklist,
      fallback: [
        {
          id: `task:${activePair.worker.threadId}`,
          type: "assigned_task",
          status: activePair.worker.status,
          text: activePair.worker.task,
          at: activePair.worker.startedAt
        },
        {
          id: `handoff:${activePair.worker.threadId}`,
          type: "handoff_prompt",
          status: activePair.worker.status,
          text: activePair.worker.handoffPrompt,
          at: activePair.worker.startedAt
        }
      ]
    };
  }, [activePair?.worker, activeWorkerThread, activeWorkerThreadLoading]);

  const workerProofRecords = useMemo(
    () => (activePair?.worker?.threadId ? proofsByThreadId[activePair.worker.threadId] ?? [] : []),
    [activePair?.worker?.threadId, proofsByThreadId]
  );

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
    if (!activePair?.hasMore) return;
    const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(activePair.id)}?before=${activePair.loadedStart}&limit=${PAGE_SIZE}`);
    setPair((current) => (current && current.id === payload.pair.id ? { ...current, messages: [...payload.pair.messages, ...current.messages], loadedStart: payload.pair.loadedStart, hasMore: payload.pair.hasMore } : current));
  }

  async function openSelfImprovementSession(request: SelfImprovementRequestView) {
    if (request.pairId) {
      await loadPairs();
      const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(request.pairId)}?limit=${PAGE_SIZE}`);
      setSelectedPairId(payload.pair.id);
      setPair(payload.pair);
      setViewMode("worker");
      setLastWorkstreamMode("worker");
      setMobileSidebarOpen(false);
      setEditingTitle(false);
      setTitleDraft("");
      setTitleError(null);
      return;
    }
    if (request.threadId) {
      await postJson("/api/windows/open", { threadId: request.threadId });
    }
  }

  async function sendButler() {
    if (!activePair) return;
    const text = draft.trim();
    if (!text && composerAttachments.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(activePair.id)}/messages`, {
        text,
        target: "butler",
        imageReferenceIds: composerAttachments.filter((attachment) => attachment.mimeType.startsWith("image/")).map((attachment) => attachment.id),
        fileReferenceIds: composerAttachments.filter((attachment) => !attachment.mimeType.startsWith("image/")).map((attachment) => attachment.id)
      });
      setPair(payload.pair);
      setDraft("");
      setComposerAttachments([]);
      await loadPairs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function attachAnnotatedProof(payload: { attachment: FileReference; text: string }) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${payload.text}` : payload.text));
    setComposerAttachments((current) =>
      current.some((entry) => entry.id === payload.attachment.id) ? current : [...current, payload.attachment]
    );
    if (viewMode === "worker") setViewMode("split");
  }

  const onButlerPatchRef = useCallback((handler: ((patch: ProviderRuntimeLivePatch) => void) | null) => {
    setButlerPatchHandler(handler);
  }, []);

  const onThinkingLevelChange = useCallback(
    async (level: string) => {
      if (!activePair) return;
      const previous = activePair;
      setPair((current) => (current ? { ...current, butlerThinkingLevel: level, compose: { ...current.compose, butler: { ...current.compose.butler, thinkingLevel: level } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "butler", thinkingLevel: level });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const onButlerModelChange = useCallback(
    async (model: string) => {
      if (!activePair) return;
      const previous = activePair;
      const selected = activePair.compose.butler.availableModels.find((entry) => entry.id === model) ?? null;
      setPair((current) => (current ? { ...current, compose: { ...current.compose, butler: { ...current.compose.butler, provider: selected?.provider ?? current.compose.butler.provider, model } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "butler", model });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const onCodexEffortChange = useCallback(
    async (effort: string) => {
      if (!activePair) return;
      const previous = activePair;
      setPair((current) => (current ? { ...current, codexEffort: effort, compose: { ...current.compose, codex: { ...current.compose.codex, effort } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "codex", effort });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const onCodexModelChange = useCallback(
    async (model: string) => {
      if (!activePair) return;
      const previous = activePair;
      const selected = activePair.compose.codex.availableModels.find((entry) => entry.id === model) ?? null;
      const effort = selected && activePair.compose.codex.effort && !selected.supportedReasoningEfforts.includes(activePair.compose.codex.effort)
        ? selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0] ?? activePair.compose.codex.effort
        : activePair.compose.codex.effort;
      setPair((current) => (current ? { ...current, codexModel: model, codexEffort: effort, compose: { ...current.compose, codex: { ...current.compose.codex, model, effort } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "codex", model });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const workerVisible = manorSurface === "sessions" && viewMode !== "butler" && Boolean(activePair) && (activePair?.worker || viewMode === "worker");
  const butlerVisible = manorSurface === "sessions" && viewMode !== "worker" && Boolean(activePair);
  const cliVisible = viewMode === "cli";
  const selectTerminalTarget = useCallback((target: TerminalTarget) => {
    setTerminalTarget(target);
  }, []);
  const selectManorSurface = useCallback((surface: ManorSurface) => {
    cancelEditTitle();
    setMobileSidebarOpen(false);
    setViewMode(surface === "sessions" ? lastWorkstreamMode : surface);
  }, [cancelEditTitle, lastWorkstreamMode]);

  return (
    <main className={`app ${mobileSidebarOpen ? "is-mobile-sidebar-open" : ""} ${activePair ? "" : "is-empty"}`}>
      <Sidebar
        pairs={pairs}
        selectedPairId={selectedPairId}
        manorSurface={manorSurface}
        improvePendingCount={improvePendingCount}
        improveQueue={improveQueue}
        selectedImproveRequestId={selectedImproveRequestId}
        memorySection={memorySection}
        memorySummary={memorySummary}
        onSelect={(id) => {
          setSelectedPairId(id);
          setViewMode(lastWorkstreamMode);
          setMobileSidebarOpen(false);
          setEditingTitle(false);
          setTitleDraft("");
          setTitleError(null);
        }}
        onSelectManor={selectManorSurface}
        onSelectImproveRequest={(id) => {
          setSelectedImproveRequestId(id);
          setMobileSidebarOpen(false);
        }}
        onSelectMemorySection={(section) => {
          setMemorySection(section);
          setMobileSidebarOpen(false);
        }}
        onCreate={createPair}
        onDelete={deletePair}
        search={search}
        onSearch={setSearch}
      />
      <section className="workspace">
        <Topbar
          pair={activePair}
          viewMode={viewMode}
          workstreamMode={lastWorkstreamMode}
          onViewMode={(mode) => {
            cancelEditTitle();
            setViewMode(mode);
          }}
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
          improveRequestCount={improveQueue?.requests.length ?? 0}
          improveEligibilityBlocked={Boolean(improveQueue?.eligibility && !improveQueue.eligibility.enabled)}
          improveEligibilityMode={improveQueue?.eligibility.mode ?? null}
          memorySection={memorySection}
          memorySearch={memorySearch}
          memoryProjectFilter={memoryProjectFilter}
          memoryProjectOptions={memorySummary?.projectOptions ?? []}
          memoryActiveCount={memorySummary?.activeCount ?? 0}
          memoryTotalCount={memorySummary?.totalCount ?? 0}
          onMemorySearch={setMemorySearch}
          onMemoryProjectFilter={setMemoryProjectFilter}
        />
        {!activePair && viewMode !== "memory" && viewMode !== "improve" && viewMode !== "cli" ? (
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
            <div className={`workspace-view is-conversation ${activePair && (viewMode === "butler" || viewMode === "worker" || viewMode === "split") ? "is-active" : ""}`}>
              <div className={`workspace-body is-${viewMode}`}>
                {butlerVisible ? (
                  <ButlerPane
                    pair={activePair}
                    draft={draft}
                    busy={busy}
                    onDraft={setDraft}
                    onSend={() => void sendButler()}
                    onLoadOlder={() => void loadOlder()}
                    onButlerPatch={onButlerPatchRef}
                    onThinkingLevelChange={(level) => void onThinkingLevelChange(level)}
                    onButlerModelChange={(model) => void onButlerModelChange(model)}
                    attachments={composerAttachments}
                    onRemoveAttachment={(attachmentId) => setComposerAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))}
                    onPreviewImage={(media) => {
                      setPreviewError(null);
                      setPreviewMedia(media);
                    }}
                  />
                ) : null}
                {viewMode === "split" ? <div className="divider" /> : null}
                {workerVisible ? (
                  <WorkerPane
                    pair={activePair}
                    timeline={workerTimeline}
                    loading={activeWorkerThreadLoading}
                    proofRecords={workerProofRecords}
                    onCodexModelChange={(model) => void onCodexModelChange(model)}
                    onCodexEffortChange={(effort) => void onCodexEffortChange(effort)}
                    onAttachAnnotatedProof={(payload) => attachAnnotatedProof(payload)}
                  />
                ) : null}
              </div>
              {error ? (
                <div className="error" role="alert">
                  <WarningIcon />
                  <span>{error}</span>
                </div>
              ) : null}
              {previewError ? (
                <div className="error" role="alert">
                  <WarningIcon />
                  <span>{previewError}</span>
                </div>
              ) : null}
              {previewMedia ? (
                <ImagePreviewModal
                  media={previewMedia}
                  attachTargetLabel="Butler composer"
                  onAttached={attachAnnotatedProof}
                  onClose={() => setPreviewMedia(null)}
                  showErrorToast={(err) => setPreviewError(err instanceof Error ? err.message : String(err))}
                />
              ) : null}
            </div>
            <div className={`workspace-view is-memory ${viewMode === "memory" ? "is-active" : ""}`}>
              <MemoryDashboard
                showHeader={false}
                showSections={false}
                section={memorySection}
                onSectionChange={setMemorySection}
                search={memorySearch}
                onSearchChange={setMemorySearch}
                projectFilter={memoryProjectFilter}
                onProjectFilterChange={setMemoryProjectFilter}
                onSummaryChange={setMemorySummary}
              />
            </div>
            <div className={`workspace-view is-improve ${viewMode === "improve" ? "is-active" : ""}`}>
              <SelfImprovementQueue
                data={improveQueue}
                selectedId={selectedImproveRequestId}
                onReload={loadImproveQueue}
                onOpenSession={openSelfImprovementSession}
              />
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
