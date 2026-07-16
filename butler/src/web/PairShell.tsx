import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getJson, isVisionImageFile, patchJson, postJson, uploadAttachment, type FileReference } from "./api";
import manorLogoLight from "./assets/manor-logo.svg";
import manorLogoDark from "./assets/manor-logo-dark.svg";
import { ButlerPane } from "./ButlerPane";
import { FileExplorer } from "./FileExplorer";
import { ExtensionUiBridge } from "./ExtensionUiBridge";
import {
  ChevronLeftIcon,
  FilesIcon,
  MenuIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SetupTabIcon,
  StatusIcon,
  ThreadsIcon,
  WarningIcon
} from "./icons";
import { MemoryDashboard, type MemoryDashboardSummary, type MemoryProjectOption, type MemorySearchMode } from "./MemoryDashboard";
import { ManorVersion } from "./ManorVersion";
import { PairRow } from "./PairRow";
import { ImagePreviewModal, type PreviewMedia } from "./ImagePreviewModal";
import { readPairUrlState, writePairUrl, type PairUrlHistoryMode } from "./pair-url-state";
import {
  canBeginPairDeletion,
  reconcileSelectedPairId,
  shouldClearDeletedPairSelection,
  shouldReportPairDetailError
} from "./pair-selection";
import { SandSpinner } from "./SandSpinner";
import { listenForSkillInstallHandoff, readSkillInstallHandoff, removeSkillInstallHandoff, shouldCreateSkillInstallSession, SKILL_INSTALL_HANDOFF_PLACEHOLDER } from "./skill-install-handoff";
import { SelfImprovementQueue, formatSelfImprovementTime, selfImprovementStatusLabel } from "./SelfImprovementQueue";
import { SettingsDashboard, SETTINGS_SECTIONS, type SettingsSectionId } from "./SettingsDashboard";
import { SessionWorkspaceControl } from "./SessionWorkspaceControl"; import { SessionAutomationControl } from "./SessionAutomationControl";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-preference";
import { TerminalPane } from "./TerminalPane";
import { useEventStream } from "./useEventStream"; import { useProjectArtifactPreview } from "./useProjectArtifactPreview"; import { useSessionAutomation } from "./useSessionAutomation";
import { useWorkerThreadHistory } from "./useWorkerThreadHistory";
import { WorkerPane } from "./WorkerPane";
import type { WorkerTimeline } from "./WorkerPane";
import { shapeWorkerTimeline } from "./worker-timeline";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type { MemorySection } from "../shared/memory";
import type { SelfImprovementQueueResponse, SelfImprovementRequestView } from "../shared/self-improvement";
import type {
  PairDetail,
  PairAutomation,
  PairDetailResponse,
  PairListResponse,
  PairComposerInputItem,
  PairMessage,
  PairStatus,
  PairSummary,
  PairViewMode,
  PairWorkerHarness
} from "../shared/pairing";
import type { TerminalTarget } from "../shared/terminal";

type WorkerHandoffUiState = {
  requestId: number;
  pending: boolean;
  error: string | null;
};
const PAGE_SIZE = 120;
const PAIR_LIST_ROW = 64;
const VIEW_LABELS: Record<PairViewMode, string> = {
  butler: "Butler",
  worker: "Worker",
  split: "Both",
  files: "Files",
  memory: "Memory",
  improve: "Improve",
  settings: "Settings",
  cli: "CLI"
};
type WorkstreamViewMode = Exclude<PairViewMode, "files" | "memory" | "improve" | "settings">;
type ManorSurface = "sessions" | "files" | "memory" | "improve" | "settings";
const WORKSTREAM_MODES: WorkstreamViewMode[] = ["butler", "worker", "split", "cli"];

function manorSurfaceForView(viewMode: PairViewMode): ManorSurface {
  if (viewMode === "files" || viewMode === "memory" || viewMode === "improve" || viewMode === "settings") return viewMode;
  return "sessions";
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

function Sidebar({
  pairs,
  selectedPairId,
  manorSurface,
  improvePendingCount,
  improveQueue,
  selectedImproveRequestId,
  memorySection,
  memorySummary,
  settingsSection,
  onSelect,
  onSelectManor,
  onSelectImproveRequest,
  onSelectMemorySection,
  onSelectSettingsSection,
  onCreate,
  onDelete,
  collapsed,
  onToggleCollapsed,
  onCloseMobile,
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
  settingsSection: SettingsSectionId;
  onSelect: (id: string) => void;
  onSelectManor: (surface: ManorSurface) => void;
  onSelectImproveRequest: (id: string) => void;
  onSelectMemorySection: (section: MemorySection) => void;
  onSelectSettingsSection: (section: SettingsSectionId) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
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
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""} ${manorSurface === "sessions" ? "" : "is-surface-only"}`}>
      <div className="sidebar-head">
        <div className="brand">
          <picture className="brand-logo">
            <source srcSet={manorLogoLight} media="(prefers-color-scheme: light)" />
            <img src={manorLogoDark} alt="Manor" />
          </picture>
        </div>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeftIcon />
        </button>
        <button className="sidebar-mobile-close" type="button" onClick={onCloseMobile} aria-label="Close navigation" title="Close navigation">
          <ChevronLeftIcon />
        </button>
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
            className={`sidebar-nav-item ${manorSurface === "files" ? "is-selected" : ""}`}
            type="button"
            aria-label="Files"
            aria-current={manorSurface === "files" ? "page" : undefined}
            onClick={() => onSelectManor("files")}
            title="Files"
          >
            <FilesIcon />
            <span>Files</span>
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

      <div className="sidebar-body">
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
        {manorSurface === "files" ? (
          <>
            <div className="sidebar-surface-head">
              <div className="sidebar-surface-title">
                <span className="sidebar-surface-label">Files</span>
              </div>
            </div>
            <div className="sidebar-surface-note">Durable inputs shared across sessions and Workers.</div>
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
                const label = sectionOption === "projects" ? "Projects" : sectionOption === "jobs" ? "Jobs" : "Global";
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
        {manorSurface === "settings" ? (
          <>
            <div className="sidebar-surface-head">
              <div className="sidebar-surface-title">
                <span className="sidebar-surface-label">Settings</span>
              </div>
            </div>
            <div className="sidebar-surface-list" aria-label="Settings sections">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`sidebar-surface-item ${settingsSection === section.id ? "is-active" : ""}`}
                  aria-current={settingsSection === section.id ? "page" : undefined}
                  onClick={() => onSelectSettingsSection(section.id)}
                >
                  <span className="sidebar-surface-item-title">{section.label}</span>
                  <span className="sidebar-surface-item-preview">{section.description}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <button
          className={`sidebar-settings-button ${manorSurface === "settings" ? "is-active" : ""}`}
          type="button"
          aria-label="Settings"
          aria-current={manorSurface === "settings" ? "page" : undefined}
          onClick={() => onSelectManor("settings")}
          title="Settings"
        >
          <SetupTabIcon />
          <span>Settings</span>
        </button>
        <ManorVersion version={__MANOR_VERSION__} />
      </div>
    </aside>
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
  memorySection,
  memorySearch,
  memorySearchMode,
  memoryProjectFilter,
  memoryProjectOptions,
  memoryActiveCount,
  memoryTotalCount,
  settingsSection,
  onMemorySearch,
  onMemorySearchMode,
  onMemoryProjectFilter,
  workspacePending, onWorkspaceChange,
  automationPending, onAutomationEnabledChange, onAutomationDelete, onAutomationEdit
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
  memorySection: MemorySection;
  memorySearch: string;
  memorySearchMode: MemorySearchMode;
  memoryProjectFilter: string;
  memoryProjectOptions: MemoryProjectOption[];
  memoryActiveCount: number;
  memoryTotalCount: number;
  settingsSection: SettingsSectionId;
  onMemorySearch: (value: string) => void;
  onMemorySearchMode: (mode: MemorySearchMode) => void;
  onMemoryProjectFilter: (value: string) => void;
  workspacePending: boolean; onWorkspaceChange: (cwd: string) => Promise<void>;
  automationPending: boolean; onAutomationEnabledChange: (enabled: boolean) => Promise<void>;
  onAutomationDelete: () => Promise<void>; onAutomationEdit: () => void;
}) {
  const isGlobalSurface = viewMode === "files" || viewMode === "memory" || viewMode === "improve" || viewMode === "settings";
  const surfaceTitle = viewMode === "files" ? "Files" : viewMode === "memory" ? "Memory" : viewMode === "improve" ? "Self-improvement" : viewMode === "settings" ? "Settings" : null;
  const settingsSectionLabel = SETTINGS_SECTIONS.find((section) => section.id === settingsSection)?.label ?? "Runtime";
  const surfaceMeta =
    viewMode === "files"
      ? "Durable storage"
      : viewMode === "memory"
      ? memorySearchMode === "agent"
        ? "Butler retrieval preview"
        : `${memoryActiveCount} of ${memoryTotalCount} ${memorySection === "butler" ? "global" : memorySection}`
      : viewMode === "improve"
        ? `${improveRequestCount} requests`
        : viewMode === "settings"
          ? settingsSectionLabel
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
        <div className={`topbar-heading ${pair && !isGlobalSurface ? "has-workspace" : ""}`}>
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
              <span className="topbar-worker-loader" aria-label="Worker is working"><SandSpinner /></span>
            ) : null}
            {pair && !isGlobalSurface && editingTitle && titleError ? <span className="title-error" role="alert">{titleError}</span> : null}
          </div>
          {pair && !isGlobalSurface ? <div className="session-meta-controls"><SessionWorkspaceControl pair={pair} pending={workspacePending} onChange={onWorkspaceChange} /><SessionAutomationControl pair={pair} pending={automationPending} onEnabledChange={onAutomationEnabledChange} onDelete={onAutomationDelete} onEdit={onAutomationEdit} /></div> : null}
        </div>
      </div>
      <div className="topbar-right">
        {viewMode === "memory" ? (
          <div className="topbar-memory-controls">
            <div className="memory-search-mode" role="group" aria-label="Memory search mode">
              <button type="button" className={memorySearchMode === "browse" ? "is-active" : ""} onClick={() => onMemorySearchMode("browse")}>Browse</button>
              <button type="button" className={memorySearchMode === "agent" ? "is-active" : ""} onClick={() => onMemorySearchMode("agent")}>Agent preview</button>
            </div>
            <div className="search dashboard-search">
              <span className="search-icon">
                <SearchIcon />
              </span>
              <input
                type="search"
                placeholder={memorySearchMode === "agent" ? "Search memory as Butler…" : `Filter ${memorySection === "butler" ? "global" : memorySection}…`}
                value={memorySearch}
                onChange={(event) => onMemorySearch(event.target.value)}
                aria-label={`Search ${memorySection === "butler" ? "global" : memorySection}`}
              />
            </div>
            <select
              className="dashboard-project-filter"
              value={memoryProjectFilter}
              onChange={(event) => onMemoryProjectFilter(event.target.value)}
              aria-label="Filter by project"
              disabled={memorySearchMode === "browse" && memorySection === "butler"}
            >
              <option value="">{memorySearchMode === "agent" ? "All projects" : memorySection === "butler" ? "Global" : "All projects"}</option>
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
            Disabled
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
  const [initialUrlState] = useState(readPairUrlState);
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [pairsLoaded, setPairsLoaded] = useState(false);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(initialUrlState.sessionId);
  const [pair, setPair] = useState<PairDetail | null>(null);
  const [viewMode, setViewMode] = useState<PairViewMode>(initialUrlState.viewMode);
  const [lastWorkstreamMode, setLastWorkstreamMode] = useState<WorkstreamViewMode>(() => {
    const initial = initialUrlState.viewMode;
    return initial === "files" || initial === "memory" || initial === "improve" || initial === "settings" ? "butler" : initial;
  });
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(initialUrlState.settingsSection);
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>(initialUrlState.terminalTarget);
  const skillInstallHandoffPending = useRef(readSkillInstallHandoff(window.location.search));
  const skillInstallSessionCreating = useRef(false); const skillInstallSessionRequest = useRef(0);
  const [skillInstallIntent, setSkillInstallIntent] = useState(skillInstallHandoffPending.current);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false); const [stoppingButler, setStoppingButler] = useState(false);
  const [butlerComposePending, setButlerComposePending] = useState(0);
  const [workerHandoffByPairId, setWorkerHandoffByPairId] = useState<Record<string, WorkerHandoffUiState>>({});
  const workerHandoffRequestCounter = useRef(0);
  const latestWorkerHandoffRequestByPairId = useRef(new Map<string, number>());
  const [error, setError] = useState<string | null>(null);
  const [workspacePending, setWorkspacePending] = useState(false);
  const selectedPairIdRef = useRef<string | null>(initialUrlState.sessionId);
  const pairUrlHistoryModeRef = useRef<PairUrlHistoryMode>("replace");
  const suppressedPairDetailErrorsRef = useRef(new Set<string>());
  const pairListRequestRef = useRef(0);
  const selectPairId = useCallback((pairId: string | null, pushHistory = false) => {
    if (pushHistory && pairId !== selectedPairIdRef.current) pairUrlHistoryModeRef.current = "push";
    selectedPairIdRef.current = pairId;
    setSelectedPairId(pairId);
  }, []);
  const [search, setSearch] = useState("");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(readSidebarCollapsed);
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
  const [memorySearchMode, setMemorySearchMode] = useState<MemorySearchMode>("browse");
  const [memoryProjectFilter, setMemoryProjectFilter] = useState("");
  const [memorySummary, setMemorySummary] = useState<MemoryDashboardSummary | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<FileReference[]>([]);
  const [composerContextItems, setComposerContextItems] = useState<PairComposerInputItem[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const { openProjectArtifact, openProjectArtifactFile, dialog: projectArtifactPreview } = useProjectArtifactPreview((message) => setPreviewError(message || null));
  useEffect(() => setComposerContextItems([]), [selectedPairId]);
  useEffect(() => writeSidebarCollapsed(desktopSidebarCollapsed), [desktopSidebarCollapsed]);
  const manorSurface = manorSurfaceForView(viewMode);
  const activePair = pair?.id === selectedPairId ? pair : null;
  const activeWorkerHandoff = activePair ? workerHandoffByPairId[activePair.id] ?? null : null;
  const shouldLoadWorkerThread = manorSurface === "sessions" && viewMode !== "butler" && Boolean(activePair?.worker);
  const activeWorkerPairId = shouldLoadWorkerThread ? activePair?.id ?? null : null;
  const activeWorkerThreadId = shouldLoadWorkerThread ? activePair?.worker?.threadId ?? null : null;
  const workerHistory = useWorkerThreadHistory(activeWorkerPairId, activeWorkerThreadId, setError);
  const activeWorkerThread = workerHistory.thread;
  const activeWorkerThreadLoading = workerHistory.loading;
  const eventStream = useEventStream({
    onButlerPatch: (patch) => {
      if (!activePair || patch.threadId !== `butler:${activePair.id}`) return;
      butlerPatchHandler?.(patch);
    },
    onThreadPatch: (patch) => {
      if (!activeWorkerThreadId || patch.threadId !== activeWorkerThreadId) return;
      const urgent = (patch.kind === "turn-lifecycle" && patch.status !== "started") ||
        (patch.kind === "runtime-message" && patch.tone === "error");
      workerHistory.requestRefresh(urgent);
    },
    onWorkerThreadRefreshed: ({ threadId }) => {
      if (threadId === activeWorkerThreadId) workerHistory.requestRefresh(true);
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
    const requestId = ++pairListRequestRef.current;
    const payload = await getJson<PairListResponse>("/api/pairs");
    if (requestId !== pairListRequestRef.current) return;
    startTransition(() => {
      setPairs(payload.pairs);
      selectPairId(reconcileSelectedPairId(selectedPairIdRef.current, payload.pairs));
      setPairsLoaded(true);
    });
    return payload;
  }, [selectPairId]);

  useEffect(() => {
    const historyMode = pairUrlHistoryModeRef.current;
    pairUrlHistoryModeRef.current = "replace";
    writePairUrl(window.history, window.location.href, {
      sessionId: selectedPairId, viewMode, terminalTarget, settingsSection
    }, historyMode);
  }, [selectedPairId, settingsSection, terminalTarget, viewMode]);

  useEffect(() => { if (readSkillInstallHandoff(window.location.search)) window.history.replaceState(null, "", removeSkillInstallHandoff(window.location.href)); }, []);

  useEffect(() => {
    const onPopState = () => {
      const urlState = readPairUrlState();
      selectPairId(pairsLoaded ? reconcileSelectedPairId(urlState.sessionId, pairs) : urlState.sessionId);
      setViewMode(urlState.viewMode);
      setSettingsSection(urlState.settingsSection);
      setTerminalTarget(urlState.terminalTarget);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [pairs, pairsLoaded, selectPairId]);

  useEffect(() => {
    if (viewMode !== "files" && viewMode !== "memory" && viewMode !== "improve" && viewMode !== "settings") setLastWorkstreamMode(viewMode);
  }, [viewMode]);
  useEffect(() => { if (manorSurface !== "sessions") { skillInstallHandoffPending.current = false; skillInstallSessionRequest.current += 1; setSkillInstallIntent(false); } }, [manorSurface]);

  useEffect(() => {
    void loadPairs().then((payload) => {
      if (skillInstallHandoffPending.current && payload.pairs.length === 0) createSkillInstallSession();
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const interval = window.setInterval(() => void loadPairs().catch(() => undefined), 5000);
    return () => window.clearInterval(interval);
  }, [loadPairs]);

  useEffect(() => {
    if (!activePair || !skillInstallHandoffPending.current) return;
    skillInstallHandoffPending.current = false;
    setViewMode("butler");
    setLastWorkstreamMode("butler");
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }, [activePair]);
  useEffect(() => listenForSkillInstallHandoff(() => {
    setSkillInstallIntent(true); setViewMode("butler"); setLastWorkstreamMode("butler");
    if (shouldCreateSkillInstallSession(selectedPairIdRef.current, skillInstallSessionCreating.current)) { skillInstallHandoffPending.current = true; createSkillInstallSession(); return; }
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }), []);
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

  useEffect(() => {
    if (!pairsLoaded) return;
    if (!selectedPairId) {
      setPair(null);
      return;
    }
    let cancelled = false;
    const pairId = selectedPairId;
    const refresh = async () => {
      try {
        const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pairId)}?limit=${PAGE_SIZE}`);
        if (!cancelled) {
          startTransition(() => setPair(payload.pair));
        }
      } catch (err) {
        if (!cancelled && shouldReportPairDetailError(
          pairId,
          selectedPairIdRef.current,
          suppressedPairDetailErrorsRef.current
        )) {
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
  }, [pairsLoaded, selectedPairId]);

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

  async function createPair(): Promise<boolean> { return createPairWithActivation(() => true); }
  async function createPairWithActivation(activate: () => boolean): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>("/api/pairs", { title: "New session" });
      await loadPairs(); if (!activate()) return true;
      selectPairId(payload.pair.id, true);
      setPair(payload.pair);
      setViewMode("butler");
      setMobileSidebarOpen(false);
      setEditingTitle(false);
      setTitleDraft("");
      setTitleError(null); return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err)); return false;
    } finally {
      setBusy(false);
    }
  }
  function createSkillInstallSession() { if (!skillInstallSessionCreating.current) { const requestId = ++skillInstallSessionRequest.current; skillInstallSessionCreating.current = true; skillInstallHandoffPending.current = false; void createPairWithActivation(() => requestId === skillInstallSessionRequest.current).then((created) => { if (!created && requestId === skillInstallSessionRequest.current) setSkillInstallIntent(false); }).finally(() => { skillInstallSessionCreating.current = false; if (requestId === skillInstallSessionRequest.current) window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); }); } }

  async function deletePair(pairId: string) {
    if (!canBeginPairDeletion(pairId, suppressedPairDetailErrorsRef.current)) return;
    if (!window.confirm("Delete this session? This cannot be undone.")) return;
    suppressedPairDetailErrorsRef.current.add(pairId);
    try {
      const response = await fetch(`/api/pairs/${encodeURIComponent(pairId)}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed with ${response.status}`);
      }
    } catch (err) {
      suppressedPairDetailErrorsRef.current.delete(pairId);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (shouldClearDeletedPairSelection(pairId, selectedPairIdRef.current)) {
      selectPairId(null);
      setPair(null);
      setEditingTitle(false);
      setTitleDraft("");
      setTitleError(null);
    }
    try {
      await loadPairs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      suppressedPairDetailErrorsRef.current.delete(pairId);
    }
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
      selectPairId(payload.pair.id, true);
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
    if (!activePair || butlerComposePending > 0) return;
    const text = draft.trim();
    if (!text && composerAttachments.length === 0 && composerContextItems.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(activePair.id)}/messages`, {
        text,
        target: "butler",
        inputItems: composerContextItems,
        imageReferenceIds: composerAttachments.filter((attachment) => isVisionImageFile(attachment.mimeType, attachment.name)).map((attachment) => attachment.id),
        fileReferenceIds: composerAttachments.filter((attachment) => !isVisionImageFile(attachment.mimeType, attachment.name)).map((attachment) => attachment.id)
      });
      setPair(payload.pair);
      setDraft("");
      setSkillInstallIntent(false);
      setComposerAttachments([]);
      setComposerContextItems([]);
      setUploadError(null);
      await loadPairs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadComposerFiles(files: File[]) {
    const images = files.filter((file) => isVisionImageFile(file.type, file.name));
    const otherFiles = files.filter((file) => !isVisionImageFile(file.type, file.name));
    if (images.some((file) => file.size > 3 * 1024 * 1024)) {
      setUploadError("Each image must be 3 MB or smaller.");
      return;
    }
    const currentImageBytes = composerAttachments
      .filter((attachment) => isVisionImageFile(attachment.mimeType, attachment.name))
      .reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (currentImageBytes + images.reduce((total, file) => total + file.size, 0) > 12 * 1024 * 1024) {
      setUploadError("Attached images must total 12 MB or less.");
      return;
    }
    if (otherFiles.some((file) => file.size > 40 * 1024 * 1024)) {
      setUploadError("Each non-image file must be 40 MB or smaller.");
      return;
    }
    setUploadingFiles(true);
    setUploadError(null);
    try {
      const results = await Promise.allSettled(files.map((file) => uploadAttachment(file, {
        sessionId: activePair.id,
        origin: "butler-upload"
      })));
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (uploaded.length > 0) {
        setComposerAttachments((current) => {
          const knownIds = new Set(current.map((attachment) => attachment.id));
          return [...current, ...uploaded.filter((attachment) => !knownIds.has(attachment.id))];
        });
      }
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        const firstFailure = failures[0];
        setUploadError(firstFailure?.status === "rejected" && firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : `${failures.length} ${failures.length === 1 ? "file" : "files"} could not be uploaded.`);
      }
    } finally {
      setUploadingFiles(false);
    }
  }

  async function updateReview(action: "retry-review" | "stop-review") {
    if (!activePair) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(activePair.id)}/${action}`, {});
      setPair(payload.pair);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopButler() {
    if (!activePair || stoppingButler) return;
    setStoppingButler(true); setError(null);
    try {
      await postJson<{ ok: true }>(`/api/pairs/${encodeURIComponent(activePair.id)}/stop`, {});
      setPair((await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(activePair.id)}?limit=${PAGE_SIZE}`)).pair);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setStoppingButler(false); }
  }
  async function attachAnnotatedProof(payload: { attachment: FileReference; text: string }) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${payload.text}` : payload.text));
    setComposerAttachments((current) =>
      current.some((entry) => entry.id === payload.attachment.id) ? current : [...current, payload.attachment]
    );
    if (manorSurface !== "sessions") {
      setViewMode("butler");
      setLastWorkstreamMode("butler");
    } else if (viewMode === "worker") {
      setViewMode("split");
    }
  }

  const onButlerPatchRef = useCallback((handler: ((patch: ProviderRuntimeLivePatch) => void) | null) => {
    setButlerPatchHandler(handler);
  }, []);

  const onThinkingLevelChange = useCallback(
    async (level: string) => {
      if (!activePair) return;
      const previous = activePair;
      setButlerComposePending((count) => count + 1);
      setPair((current) => (current ? { ...current, butlerThinkingLevel: level, compose: { ...current.compose, butler: { ...current.compose.butler, thinkingLevel: level } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "butler", thinkingLevel: level });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      } finally {
        setButlerComposePending((count) => Math.max(0, count - 1));
      }
    },
    [activePair]
  );

  const onButlerModelChange = useCallback(
    async (model: string) => {
      if (!activePair) return;
      const previous = activePair;
      setButlerComposePending((count) => count + 1);
      const selected = activePair.compose.butler.availableModels.find((entry) => entry.id === model) ?? null;
      setPair((current) => (current ? { ...current, compose: { ...current.compose, butler: { ...current.compose.butler, provider: selected?.provider ?? current.compose.butler.provider, model } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "butler", model });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      } finally {
        setButlerComposePending((count) => Math.max(0, count - 1));
      }
    },
    [activePair]
  );

  const onWorkerEffortChange = useCallback(
    async (effort: string) => {
      if (!activePair) return;
      const previous = activePair;
      setPair((current) => (current ? {
        ...current,
        ...(current.worker ? { worker: { ...current.worker, requestedReasoningEffort: effort } } : { workerEffort: effort }),
        compose: { ...current.compose, worker: { ...current.compose.worker, effort } }
      } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "worker", effort });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const onWorkerModelChange = useCallback(
    async (model: string, harness: PairWorkerHarness | null) => {
      if (!activePair) return;
      const previous = activePair;
      const workerCompose = activePair.compose.worker;
      const selected = workerCompose.availableModels.find((entry) => entry.id === model && (entry.harness ?? null) === harness) ?? null;
      const effort = selected && workerCompose.effort && !selected.supportedReasoningEfforts.includes(workerCompose.effort)
        ? selected.defaultReasoningEffort ?? selected.supportedReasoningEfforts[0] ?? workerCompose.effort
        : workerCompose.effort;
      setPair((current) => (current ? { ...current, workerHarness: harness, workerModel: model, workerEffort: effort, compose: { ...current.compose, worker: { ...current.compose.worker, harness, model, effort, provider: selected?.provider ?? current.compose.worker.provider } } } : current));
      try {
        const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(activePair.id)}/settings`, { target: "worker", model, harness });
        setPair(payload.pair);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPair(previous);
      }
    },
    [activePair]
  );

  const onWorkerHandoff = useCallback(async (model: string, harness: PairWorkerHarness | null, effort: string | null): Promise<boolean> => {
    if (!activePair?.worker) return false;
    const pairId = activePair.id;
    const sourceThreadId = activePair.worker.threadId;
    const requestId = ++workerHandoffRequestCounter.current;
    latestWorkerHandoffRequestByPairId.current.set(pairId, requestId);
    setWorkerHandoffByPairId((current) => ({
      ...current,
      [pairId]: { requestId, pending: true, error: null }
    }));
    try {
      const payload = await postJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(pairId)}/worker/handoff`, { model, harness, effort });
      if (latestWorkerHandoffRequestByPairId.current.get(pairId) !== requestId) return false;
      setPair((current) => {
        if (!current || current.id !== pairId) return current;
        const currentThreadId = current.worker?.threadId ?? null;
        const responseThreadId = payload.pair.worker?.threadId ?? null;
        if (currentThreadId && currentThreadId !== sourceThreadId && currentThreadId !== responseThreadId) return current;
        return payload.pair;
      });
      await loadPairs().catch(() => undefined);
      return true;
    } catch (err) {
      if (latestWorkerHandoffRequestByPairId.current.get(pairId) === requestId) {
        setWorkerHandoffByPairId((current) => current[pairId]?.requestId === requestId
          ? { ...current, [pairId]: { requestId, pending: false, error: err instanceof Error ? err.message : String(err) } }
          : current);
      }
      return false;
    } finally {
      if (latestWorkerHandoffRequestByPairId.current.get(pairId) === requestId) {
        setWorkerHandoffByPairId((current) => current[pairId]?.requestId === requestId
          ? { ...current, [pairId]: { ...current[pairId], pending: false } }
          : current);
      }
    }
  }, [activePair, loadPairs]);

  const workerVisible = manorSurface === "sessions" && viewMode !== "butler" && Boolean(activePair);
  const butlerVisible = manorSurface === "sessions" && viewMode !== "worker" && Boolean(activePair);
  const cliVisible = viewMode === "cli";
  const selectTerminalTarget = useCallback((target: TerminalTarget) => {
    setTerminalTarget(target);
  }, []);
  const applyExtensionEditorText = useCallback((text: string) => setDraft(text), []);
  const selectManorSurface = useCallback((surface: ManorSurface) => {
    cancelEditTitle(); setMobileSidebarOpen(false);
    setViewMode(surface === "sessions" ? lastWorkstreamMode : surface);
  }, [cancelEditTitle, lastWorkstreamMode]);
  const selectSettingsSection = useCallback((section: SettingsSectionId) => {
    cancelEditTitle();
    setSettingsSection(section);
    setViewMode("settings");
    setMobileSidebarOpen(false);
  }, [cancelEditTitle]);
  const changeWorkspace = useCallback(async (cwd: string) => {
    if (!activePair || workspacePending) return;
    const pairId = activePair.id;
    setWorkspacePending(true);
    try {
      const payload = await patchJson<{ pair: PairDetail }>(`/api/pairs/${encodeURIComponent(pairId)}/workspace`, { cwd });
      setPair((current) => current?.id === pairId ? payload.pair : current);
      setPairs((current) => current.map((entry) => entry.id === payload.pair.id ? { ...entry, defaultCwd: payload.pair.defaultCwd, worker: payload.pair.worker, updatedAt: payload.pair.updatedAt } : entry));
      if (selectedPairIdRef.current === pairId) setComposerContextItems([]);
    } finally {
      setWorkspacePending(false);
    }
  }, [activePair, workspacePending]);

  const applyAutomation = useCallback((automation: PairAutomation | null) => {
    if (!activePair) return;
    setPair((current) => current?.id === activePair.id ? { ...current, automation } : current);
    setPairs((current) => current.map((entry) => entry.id === activePair.id ? { ...entry, automation } : entry));
  }, [activePair]);
  const editAutomationWithButler = useCallback((automation: PairAutomation) => {
    setDraft(`Update this session automation.\n\nCurrent task: ${automation.instruction}\nCurrent schedule: ${automation.scheduleLabel}${automation.endsAtLabel ? `\nRuns through: ${automation.endsAtLabel}` : ""}`);
    setViewMode("butler"); setLastWorkstreamMode("butler");
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
  }, []); const automationActions = useSessionAutomation(activePair, applyAutomation, editAutomationWithButler);

  return (
    <main className={`app ${desktopSidebarCollapsed ? "is-sidebar-collapsed" : ""} ${mobileSidebarOpen ? "is-mobile-sidebar-open" : ""} ${activePair ? "" : "is-empty"}`}>
      <Sidebar
        pairs={pairs}
        selectedPairId={selectedPairId}
        manorSurface={manorSurface}
        improvePendingCount={improvePendingCount}
        improveQueue={improveQueue}
        selectedImproveRequestId={selectedImproveRequestId}
        memorySection={memorySection}
        memorySummary={memorySummary}
        settingsSection={settingsSection}
        onSelect={(id) => {
          selectPairId(id, true); setSkillInstallIntent(false); setViewMode(lastWorkstreamMode);
          setMobileSidebarOpen(false); setEditingTitle(false); setTitleDraft(""); setTitleError(null);
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
        onSelectSettingsSection={selectSettingsSection}
        onCreate={() => void createPair()}
        onDelete={deletePair}
        collapsed={desktopSidebarCollapsed}
        onToggleCollapsed={() => setDesktopSidebarCollapsed((collapsed) => !collapsed)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
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
          memorySection={memorySection}
          memorySearch={memorySearch}
          memorySearchMode={memorySearchMode}
          memoryProjectFilter={memoryProjectFilter}
          memoryProjectOptions={memorySummary?.projectOptions ?? []}
          memoryActiveCount={memorySummary?.activeCount ?? 0}
          memoryTotalCount={memorySummary?.totalCount ?? 0}
          settingsSection={settingsSection}
          onMemorySearch={setMemorySearch}
          onMemorySearchMode={setMemorySearchMode}
          onMemoryProjectFilter={setMemoryProjectFilter}
          workspacePending={workspacePending}
          onWorkspaceChange={changeWorkspace}
          automationPending={automationActions.pending} onAutomationEnabledChange={automationActions.setEnabled}
          onAutomationDelete={automationActions.remove} onAutomationEdit={automationActions.edit}
        />
        {!activePair && viewMode !== "files" && viewMode !== "memory" && viewMode !== "improve" && viewMode !== "settings" && viewMode !== "cli" ? (
          <div className="empty-state">
            <picture className="empty-logo">
              <source srcSet={manorLogoLight} media="(prefers-color-scheme: light)" />
              <img src={manorLogoDark} alt="Manor" />
            </picture>
            <h2>Welcome to Manor</h2>
            <p>Create a new session to start a scoped conversation with one Worker.</p>
            <button className="button is-primary" type="button" onClick={() => void createPair()} disabled={busy}>
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
                    composerPlaceholder={skillInstallIntent ? SKILL_INSTALL_HANDOFF_PLACEHOLDER : undefined}
                    busy={busy || butlerComposePending > 0 || activePair.butlerPending}
                    composerBusy={busy || butlerComposePending > 0}
                    sendDisabled={busy || uploadingFiles || butlerComposePending > 0 || /chosen Butler model|No connected Butler model/i.test(activePair.butlerLastError ?? "")}
                    onDraft={setDraft}
                    onSend={() => void sendButler()}
                    onLoadOlder={() => void loadOlder()}
                    onButlerPatch={onButlerPatchRef}
                    onThinkingLevelChange={(level) => void onThinkingLevelChange(level)}
                    onButlerModelChange={(model) => void onButlerModelChange(model)}
                    onRetryReview={() => void updateReview("retry-review")}
                    onStopReview={() => void updateReview("stop-review")}
                    onStopButler={() => void stopButler()}
                    stoppingButler={stoppingButler} liveConnected={eventStream.connected} liveHasConnected={eventStream.hasConnected}
                    onOpenProviderSettings={() => selectSettingsSection("providers")}
                    attachments={composerAttachments}
                    onUploadFiles={(files) => void uploadComposerFiles(files)}
                    uploadingFiles={uploadingFiles}
                    uploadError={uploadError}
                    onRemoveAttachment={(attachmentId) => setComposerAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))}
                    onPreviewImage={(media) => {
                      setPreviewError(null);
                      setPreviewMedia(media);
                    }}
                    onPreviewProjectArtifact={openProjectArtifact}
                    onPreviewProjectFile={openProjectArtifactFile}
                    onPairUpdate={(updatedPair) => setPair(updatedPair)}
                    contextItems={composerContextItems}
                    onContextItemsChange={setComposerContextItems}
                  />
                ) : null}
                {viewMode === "split" ? <div className="divider" /> : null}
                {workerVisible ? (
                  <WorkerPane
                    pair={activePair}
                    timeline={workerTimeline}
                    loading={activeWorkerThreadLoading}
                    hasMore={Boolean(activeWorkerThread?.hasMore)}
                    loadingOlder={workerHistory.loadingOlder}
                    onLoadOlder={() => void workerHistory.loadOlder()}
                    proofRecords={workerHistory.proofRecords}
                    onWorkerModelChange={(model, harness) => void onWorkerModelChange(model, harness)}
                    onWorkerEffortChange={(effort) => void onWorkerEffortChange(effort)}
                    handoffPending={activeWorkerHandoff?.pending ?? false}
                    handoffError={activeWorkerHandoff?.error ?? null}
                    onHandoff={onWorkerHandoff}
                    onOpenProviderSettings={() => selectSettingsSection("providers")}
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
              {activePair?.butlerLastError ? (
                <div className="error" role="alert">
                  <WarningIcon />
                  <span>{activePair.butlerLastError}</span>
                  {/provider|auth|sign in|connect|codex access/i.test(activePair.butlerLastError)
                    ? <button className="button" type="button" onClick={() => selectSettingsSection("providers")}>Open provider settings</button>
                    : null}
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
                  uploadContext={{ sessionId: activePair?.id, origin: "image-annotation" }}
                  onAttached={attachAnnotatedProof}
                  onClose={() => setPreviewMedia(null)}
                  showErrorToast={(err) => setPreviewError(err instanceof Error ? err.message : String(err))}
                />
              ) : null}
              {projectArtifactPreview}
              <ExtensionUiBridge pairId={activePair?.id ?? null} onEditorText={applyExtensionEditorText} />
            </div>
            <div className={`workspace-view is-memory ${viewMode === "memory" ? "is-active" : ""}`}>
              <MemoryDashboard
                showHeader={false}
                showSections={false}
                section={memorySection}
                onSectionChange={setMemorySection}
                search={memorySearch}
                onSearchChange={setMemorySearch}
                searchMode={memorySearchMode}
                onSearchModeChange={setMemorySearchMode}
                projectFilter={memoryProjectFilter}
                onProjectFilterChange={setMemoryProjectFilter}
                onSummaryChange={setMemorySummary}
              />
            </div>
            <div className={`workspace-view is-files ${viewMode === "files" ? "is-active" : ""}`}>
              <FileExplorer
                active={viewMode === "files"}
                attachTargetLabel={activePair ? "Butler composer" : null}
                uploadContext={{ sessionId: activePair?.id, origin: "file-explorer" }}
                onAttached={attachAnnotatedProof}
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
            <div className={`workspace-view is-settings ${viewMode === "settings" ? "is-active" : ""}`}>
              <SettingsDashboard active={viewMode === "settings"} activeSection={settingsSection} pairId={activePair?.id ?? null} />
            </div>
            <TerminalPane active={cliVisible} target={terminalTarget} onTarget={selectTerminalTarget} />
          </div>
        )}
      </section>
    </main>
  );
}

export type { PairMessage };
