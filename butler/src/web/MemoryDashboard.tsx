import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getJson } from "./api";
import { ChevronRightIcon, SearchIcon, TrashIcon, WarningIcon } from "./icons";
import type {
  ButlerMemoryEntry,
  JobMemory,
  MemoryRetrievalResponse,
  MemorySection,
  ProjectMemory,
} from "../shared/memory";

const POLL_INTERVAL_MS = 5_000;

export type MemorySearchMode = "browse" | "agent";

export type MemoryAgentSearch = {
  query: string;
  projectId: string;
  sequence: number;
};

export type MemoryProjectOption = { id: string; label: string };

export type MemoryDashboardSummary = {
  section: MemorySection;
  activeCount: number;
  totalCount: number;
  projectOptions: MemoryProjectOption[];
  counts: Record<MemorySection, { active: number; total: number }>;
};

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatRelativeTime(value: number | null | undefined): string {
  if (!value) return "Unknown";
  const elapsed = Date.now() - value;
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function readableMemoryType(value: string | null | undefined): string {
  if (!value || value === "legacy_global") return "Global";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceLabel(value: ButlerMemoryEntry["source"]): string {
  return value === "butler_tool" ? "Butler" : "Saved from chat";
}

function sectionLabel(section: MemorySection): string {
  return section === "butler" ? "global" : section;
}

export function MemorySearchForm({
  mode,
  section,
  value,
  onChange,
  onSubmit
}: {
  mode: MemorySearchMode;
  section: MemorySection;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form className="memory-search-form" onSubmit={(event) => { event.preventDefault(); if (mode === "agent") onSubmit(); }}>
      <div className="search dashboard-search">
        <span className="search-icon"><SearchIcon /></span>
        <input
          type="search"
          placeholder={mode === "agent" ? "Search memory as Butler…" : `Filter ${sectionLabel(section)}…`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (mode !== "agent" || event.key !== "Enter") return;
            event.preventDefault();
            onSubmit();
          }}
          aria-label={mode === "agent" ? "Search memory as Butler" : `Search ${sectionLabel(section)}`}
        />
      </div>
      {mode === "agent" ? <button className="button is-primary memory-search-submit" type="submit" disabled={!value.trim()} aria-label="Search memory"><SearchIcon /><span>Search</span></button> : null}
    </form>
  );
}

function kindLabel(kind: string): string {
  if (kind === "checkpoint") return "Checkpoint";
  if (kind === "decision") return "Decision";
  if (kind === "note") return "Note";
  return kind;
}

function entryKindClass(kind: string): string {
  if (kind === "decision") return "is-decision";
  if (kind === "note") return "is-note";
  return "is-checkpoint";
}

function filterText(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (text ?? "").toLowerCase().includes(needle);
}

function useMemoryList<T>(
  path: string | null,
  params: Record<string, string | null | undefined>
): {
  items: T[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!path) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value) search.set(key, value);
    }
    const url = search.toString() ? `${path}?${search.toString()}` : path;
    getJson<{ [k: string]: T[] }>(url)
      .then((payload) => {
        if (cancelled) return;
        const firstKey = Object.keys(payload).find((key) => Array.isArray((payload as Record<string, unknown>)[key]));
        const next = firstKey ? (payload[firstKey] as T[]) : [];
        setItems(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce, JSON.stringify(params)]);

  return { items, loading, error, reload };
}

function useAgentMemoryPreview(
  search: MemoryAgentSearch | null
): {
  payload: MemoryRetrievalResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [payload, setPayload] = useState<MemoryRetrievalResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const trimmedQuery = search?.query.trim() ?? "";
    if (!trimmedQuery) {
      setPayload(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setPayload(null);
    setError(null);
    setLoading(true);
    const params = new URLSearchParams({
      query: trimmedQuery,
      limit: "6",
      preview: "1",
      includeGlobal: "1",
      includeProvenance: "1"
    });
    if (search?.projectId) params.set("projectId", search.projectId);
    getJson<MemoryRetrievalResponse>(`/api/memory/retrieve?${params.toString()}`, { signal: controller.signal })
      .then((nextPayload) => {
        setPayload(nextPayload);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [nonce, search?.projectId, search?.query, search?.sequence]);

  return { payload, loading, error, reload };
}

function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button className="button" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={`button ${danger ? "is-danger-solid" : "is-primary"}`}
            type="button"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  query,
  onDelete
}: {
  project: ProjectMemory;
  query: string;
  onDelete: (entryId: string, summary: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`memory-record ${expanded ? "is-expanded" : ""}`}>
      <button
        className="memory-record-trigger"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="memory-record-chevron"><ChevronRightIcon /></span>
        <span className="memory-record-identity">
          <span className="memory-record-title">{project.projectLabel}</span>
          <span className="memory-record-kicker">Project memory</span>
        </span>
        <span className="memory-record-preview">
          {project.summary ?? project.entries.at(-1)?.summary ?? "No project summary yet."}
        </span>
        <span className="memory-record-stats">
          <span>{project.entries.length} {project.entries.length === 1 ? "memory" : "memories"}</span>
          <time dateTime={new Date(project.updatedAt).toISOString()}>{formatRelativeTime(project.updatedAt)}</time>
        </span>
      </button>
      {expanded ? (
        <div className="memory-record-body">
          {project.entries.length === 0 ? (
            <div className="memory-empty">No entries.</div>
          ) : (
            <ul className="memory-entries">
              {project.entries.map((entry) => (
                <li key={entry.id} className={`memory-entry ${entryKindClass(entry.kind)}`}>
                  <div className="memory-entry-main">
                    <span className="memory-entry-kind">{kindLabel(entry.kind)}</span>
                    <span className="memory-entry-summary">{entry.summary}</span>
                    {filterText(entry.details, query) && entry.details ? (
                      <p className="memory-entry-details">{entry.details}</p>
                    ) : null}
                    <span className="memory-entry-meta">
                      {formatTime(entry.acceptedAt)} · source {entry.sourceThreadId.slice(0, 8)}
                    </span>
                  </div>
                  <button
                    className="icon-button is-danger"
                    type="button"
                    onClick={() => onDelete(entry.id, entry.summary)}
                    aria-label={`Delete project entry ${entry.summary}`}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}

function JobCard({
  job,
  query,
  onDeleteEntry,
  onResolveCandidate
}: {
  job: JobMemory;
  query: string;
  onDeleteEntry: (entryId: string, summary: string) => void;
  onResolveCandidate: (candidateId: string, accepted: boolean, summary: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pendingCandidates = job.promotionCandidates.filter((candidate) => candidate.status === "pending");
  const title = job.requestedTask ?? job.operatorGoal ?? job.latestCheckpoint ?? `${job.projectLabel} job`;
  const preview = job.latestCheckpoint ?? job.nextAction ?? job.operatorGoal ?? "No durable activity recorded yet.";

  return (
    <article className={`memory-record ${expanded ? "is-expanded" : ""}`}>
      <button
        className="memory-record-trigger"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="memory-record-chevron"><ChevronRightIcon /></span>
        <span className="memory-record-identity">
          <span className="memory-record-title">{title}</span>
          <span className="memory-record-kicker">
            {job.projectLabel} · <span className="memory-card-id">{job.threadId.slice(0, 8)}</span>
          </span>
        </span>
        <span className="memory-record-preview">{preview}</span>
        <span className="memory-record-stats">
          <span>{job.entries.length} {job.entries.length === 1 ? "memory" : "memories"}</span>
          {pendingCandidates.length > 0 ? <strong>{pendingCandidates.length} pending</strong> : null}
          <time dateTime={new Date(job.updatedAt).toISOString()}>{formatRelativeTime(job.updatedAt)}</time>
        </span>
      </button>
      {expanded ? (
        <div className="memory-record-body">
          {job.operatorGoal ? (
            <div className="memory-section">
              <div className="memory-section-label">Goal</div>
              <div className="memory-section-body">{job.operatorGoal}</div>
            </div>
          ) : null}
          {job.requestedTask ? (
            <div className="memory-section">
              <div className="memory-section-label">Task</div>
              <div className="memory-section-body">{job.requestedTask}</div>
            </div>
          ) : null}
          {pendingCandidates.length > 0 ? (
            <div className="memory-section">
              <div className="memory-section-label">Pending promotion candidates</div>
              <ul className="memory-entries">
                {pendingCandidates.map((candidate) => (
                  <li key={candidate.id} className="memory-entry is-candidate">
                    <div className="memory-entry-main">
                      <span className="memory-entry-kind">{kindLabel(candidate.kind)}</span>
                      <span className="memory-entry-summary">{candidate.summary}</span>
                      {filterText(candidate.details, query) && candidate.details ? (
                        <p className="memory-entry-details">{candidate.details}</p>
                      ) : null}
                    </div>
                    <div className="memory-entry-actions">
                      <button
                        className="button is-primary is-small"
                        type="button"
                        onClick={() => onResolveCandidate(candidate.id, true, candidate.summary)}
                      >
                        Accept
                      </button>
                      <button
                        className="button is-danger is-small"
                        type="button"
                        onClick={() => onResolveCandidate(candidate.id, false, candidate.summary)}
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {job.entries.length > 0 ? (
            <div className="memory-section">
              <div className="memory-section-label">Entries</div>
              <ul className="memory-entries">
                {job.entries.map((entry) => (
                  <li key={entry.id} className={`memory-entry ${entryKindClass(entry.kind)}`}>
                    <div className="memory-entry-main">
                      <span className="memory-entry-kind">{kindLabel(entry.kind)}</span>
                      <span className="memory-entry-summary">{entry.summary}</span>
                      {filterText(entry.details, query) && entry.details ? (
                        <p className="memory-entry-details">{entry.details}</p>
                      ) : null}
                      <span className="memory-entry-meta">{formatTime(entry.at)}</span>
                    </div>
                    <button
                      className="icon-button is-danger"
                      type="button"
                      onClick={() => onDeleteEntry(entry.id, entry.summary)}
                      aria-label={`Delete job entry ${entry.summary}`}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function ButlerCard({
  entry,
  query,
  onDelete
}: {
  entry: ButlerMemoryEntry;
  query: string;
  onDelete: (id: string, summary: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleTags = entry.tags.slice(0, 2);
  return (
    <article className={`memory-record ${expanded ? "is-expanded" : ""}`}>
      <div className="memory-record-head is-with-action">
        <button
          className="memory-record-trigger"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="memory-record-chevron"><ChevronRightIcon /></span>
          <span className="memory-record-identity">
            <span className="memory-record-title">{entry.summary}</span>
            <span className="memory-record-kicker">
              {sourceLabel(entry.source)} · {formatRelativeTime(entry.createdAt)}
            </span>
          </span>
          <span className="memory-record-preview">
            {entry.details ?? "No additional details."}
          </span>
          <span className="memory-record-tags">
            <span className="memory-type-badge">{readableMemoryType(entry.memoryType)}</span>
            {visibleTags.map((tag) => <span key={tag} className="memory-tag">{tag}</span>)}
            {entry.tags.length > visibleTags.length ? <span className="memory-tag-more">+{entry.tags.length - visibleTags.length}</span> : null}
          </span>
        </button>
        <button
          className="icon-button is-danger"
          type="button"
          onClick={() => onDelete(entry.id, entry.summary)}
          aria-label={`Delete butler memory ${entry.summary}`}
        >
          <TrashIcon />
        </button>
      </div>
      {expanded ? (
        <div className="memory-record-body">
          {entry.details ? <p className="memory-card-text">{entry.details}</p> : null}
          <div className="memory-entry-meta">
            Created {formatTime(entry.createdAt)} · {sourceLabel(entry.source)}
            {entry.tags.length > 0 ? ` · ${entry.tags.join(", ")}` : ""}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function AgentRetrievalPreview({
  query,
  projectId,
  payload,
  loading,
  error,
  onRetry
}: {
  query: string;
  projectId: string;
  payload: MemoryRetrievalResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const retrieval = payload?.retrieval ?? null;
  const resultCount = retrieval
    ? retrieval.projectRollups.length + retrieval.jobMemories.length + retrieval.butlerMemories.length + retrieval.pendingPromotionCandidates.length
    : 0;

  function copyBrief() {
    if (!payload?.formatted) return;
    const textarea = document.createElement("textarea");
    textarea.value = payload.formatted;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    textarea.remove();
    setCopyStatus(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyStatus("idle"), 1_500);
  }

  if (!query.trim()) {
    return (
      <div className="memory-preview-empty">
        <span className="memory-preview-empty-icon"><SearchIcon /></span>
        <h2>Search memory as Butler</h2>
        <p>Enter a question above to preview the scoped brief Butler receives from the retrieval tool.</p>
      </div>
    );
  }

  if (loading && !retrieval) {
    return (
      <div className="memory-preview-loading" aria-label="Searching memory">
        <span /> <span /> <span />
      </div>
    );
  }

  if (error) {
    return (
      <div className="memory-preview-error" role="alert">
        <WarningIcon />
        <div><strong>Memory search failed</strong><span>{error}</span></div>
        <button className="button" type="button" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  if (!retrieval || !payload) return null;

  return (
    <div className="memory-preview">
      <header className="memory-preview-head">
        <div>
          <span className="memory-preview-eyebrow">Butler retrieval preview</span>
          <h2>{resultCount === 0 ? "No brief entries matched" : `${resultCount} brief ${resultCount === 1 ? "entry" : "entries"}`}</h2>
          <p>
            Query “{retrieval.query}” · {projectId ? "Scoped to one project" : "Across all projects"} · retrieved {formatRelativeTime(retrieval.retrievedAt)}
          </p>
        </div>
        <button className="button is-small" type="button" onClick={copyBrief}>
          {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy unavailable" : "Copy agent brief"}
        </button>
      </header>

      {retrieval.warnings.length > 0 ? (
        <div className="memory-preview-warnings">
          {retrieval.warnings.map((warning) => <span key={warning}><WarningIcon />{warning}</span>)}
        </div>
      ) : null}

      {resultCount === 0 ? (
        <div className="memory-preview-no-results">
          Try a broader phrase or search across all projects.
        </div>
      ) : (
        <div className="memory-preview-groups">
          {retrieval.projectRollups.length > 0 ? (
            <section className="memory-preview-group">
              <header><h3>Project rollups</h3><span>{retrieval.projectRollups.length}</span></header>
              <ol>
                {retrieval.projectRollups.map((memory) => (
                  <li key={memory.projectId} className="memory-preview-result">
                    <span className="memory-preview-rank" />
                    <div>
                      <strong>{memory.projectLabel}</strong>
                      <p>{memory.summary ?? "No summary"}</p>
                      {memory.entries.length > 0 ? <span>Recent: {memory.entries.slice(-3).map((entry) => entry.summary).join(" · ")}</span> : null}
                    </div>
                    <span className="memory-result-badge">Project</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {retrieval.jobMemories.length > 0 ? (
            <section className="memory-preview-group">
              <header><h3>Job memories</h3><span>{retrieval.jobMemories.length}</span></header>
              <ol>
                {retrieval.jobMemories.map((memory) => (
                  <li key={memory.threadId} className="memory-preview-result">
                    <span className="memory-preview-rank" />
                    <div>
                      <strong>{memory.projectLabel}</strong>
                      <p>{memory.latestCheckpoint ?? memory.requestedTask ?? memory.operatorGoal ?? "No checkpoint"}</p>
                      <span>
                        Job {memory.threadId.slice(0, 8)} · Next: {memory.nextAction ?? "none"} · Blockers: {memory.blockers.join(" · ") || "none"}
                      </span>
                    </div>
                    <span className="memory-result-badge">Job</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {retrieval.butlerMemories.length > 0 ? (
            <section className="memory-preview-group">
              <header><h3>Global memory</h3><span>{retrieval.butlerMemories.length}</span></header>
              <ol>
                {retrieval.butlerMemories.map((memory) => (
                  <li key={memory.id} className="memory-preview-result">
                    <span className="memory-preview-rank" />
                    <div>
                      <strong>{memory.summary}</strong>
                      {memory.details ? <p>{memory.details}</p> : null}
                      <span>{sourceLabel(memory.source)} · {formatRelativeTime(memory.createdAt)}</span>
                    </div>
                    <span className="memory-result-badge">Global</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {retrieval.pendingPromotionCandidates.length > 0 ? (
            <section className="memory-preview-group is-pending">
              <header><h3>Pending memory outcomes</h3><span>{retrieval.pendingPromotionCandidates.length}</span></header>
              <ol>
                {retrieval.pendingPromotionCandidates.map((candidate) => (
                  <li key={candidate.id} className="memory-preview-result">
                    <span className="memory-preview-rank" />
                    <div>
                      <strong>{candidate.summary}</strong>
                      {candidate.details ? <p>{candidate.details}</p> : null}
                      <span>{candidate.projectLabel} · {kindLabel(candidate.kind)}</span>
                    </div>
                    <span className="memory-result-badge is-pending">Pending</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      )}

      <details className="memory-raw-brief">
        <summary>View exact agent brief</summary>
        <pre>{payload.formatted}</pre>
      </details>
    </div>
  );
}

export function MemoryDashboard({
  showTitle = true,
  showHeader = true,
  showSections = true,
  section: controlledSection,
  onSectionChange,
  search: controlledSearch,
  onSearchChange,
  searchMode: controlledSearchMode,
  onSearchModeChange,
  agentSearch: controlledAgentSearch,
  onAgentSearchSubmit,
  projectFilter: controlledProjectFilter,
  onProjectFilterChange,
  onSummaryChange
}: {
  showTitle?: boolean;
  showHeader?: boolean;
  showSections?: boolean;
  section?: MemorySection;
  onSectionChange?: (section: MemorySection) => void;
  search?: string;
  onSearchChange?: (search: string) => void;
  searchMode?: MemorySearchMode;
  onSearchModeChange?: (mode: MemorySearchMode) => void;
  agentSearch?: MemoryAgentSearch | null;
  onAgentSearchSubmit?: () => void;
  projectFilter?: string;
  onProjectFilterChange?: (projectId: string) => void;
  onSummaryChange?: (summary: MemoryDashboardSummary) => void;
}) {
  const [internalSection, setInternalSection] = useState<MemorySection>("projects");
  const [internalSearch, setInternalSearch] = useState("");
  const [internalSearchMode, setInternalSearchMode] = useState<MemorySearchMode>("browse");
  const [internalAgentSearch, setInternalAgentSearch] = useState<MemoryAgentSearch | null>(null);
  const internalAgentSearchSequence = useRef(0);
  const [internalProjectFilter, setInternalProjectFilter] = useState<string>("");
  const [jobView, setJobView] = useState<"with-memory" | "pending" | "all">("with-memory");
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "butler" | "project" | "job"; id: string; parentId: string | null; summary: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const section = controlledSection ?? internalSection;
  const search = controlledSearch ?? internalSearch;
  const searchMode = controlledSearchMode ?? internalSearchMode;
  const agentSearch = controlledAgentSearch === undefined ? internalAgentSearch : controlledAgentSearch;
  const projectFilter = controlledProjectFilter ?? internalProjectFilter;
  const setSection = onSectionChange ?? setInternalSection;
  const setSearch = onSearchChange ?? setInternalSearch;
  const setSearchMode = onSearchModeChange ?? setInternalSearchMode;
  const setProjectFilter = onProjectFilterChange ?? setInternalProjectFilter;

  const projectsQuery = useMemoryList<ProjectMemory>("/api/memory/projects", { projectId: projectFilter || null });
  const jobsQuery = useMemoryList<JobMemory>("/api/memory/jobs", { projectId: projectFilter || null });
  const butlerQuery = useMemoryList<ButlerMemoryEntry>("/api/memory/butler", { projectId: projectFilter || null });
  const submitAgentSearch = onAgentSearchSubmit ?? (() => {
    const query = search.trim();
    if (!query) return;
    setInternalAgentSearch({ query, projectId: projectFilter, sequence: ++internalAgentSearchSequence.current });
  });
  const previewQuery = useAgentMemoryPreview(agentSearch);
  const agentSearchIsStale = Boolean(agentSearch && (
    search.trim() !== agentSearch.query || projectFilter !== agentSearch.projectId
  ));

  const projects: ProjectMemory[] = projectsQuery.items;
  const jobs: JobMemory[] = jobsQuery.items;
  const butler: ButlerMemoryEntry[] = butlerQuery.items;

  const projectOptions = useMemo(() => {
    return Array.from(
      new Map(projects.map((project) => [project.projectId, { id: project.projectId, label: project.projectLabel }])).values()
    ).sort((a, b) => a.label.localeCompare(b.label));
  }, [projects]);

  const browseSearch = searchMode === "browse" ? search : "";

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      if (browseSearch && !filterText(project.projectLabel, browseSearch) && !filterText(project.summary, browseSearch)) {
        if (!project.entries.some((entry) => filterText(entry.summary, browseSearch) || filterText(entry.details, browseSearch))) {
          return false;
        }
      }
      return true;
    });
  }, [browseSearch, projects]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (!browseSearch) return true;
      if (filterText(job.latestCheckpoint, browseSearch)) return true;
      if (filterText(job.nextAction, browseSearch)) return true;
      if (filterText(job.operatorGoal, browseSearch)) return true;
      if (filterText(job.requestedTask, browseSearch)) return true;
      if (job.entries.some((entry) => filterText(entry.summary, browseSearch))) return true;
      return false;
    });
  }, [browseSearch, jobs]);

  const visibleJobs = useMemo(() => {
    if (jobView === "all") return filteredJobs;
    if (jobView === "pending") {
      return filteredJobs.filter((job) => job.promotionCandidates.some((candidate) => candidate.status === "pending"));
    }
    return filteredJobs.filter((job) => job.entries.length > 0 || job.decisions.length > 0 || Boolean(job.latestCheckpoint));
  }, [filteredJobs, jobView]);

  const filteredButler = useMemo(() => {
    return butler.filter((entry) => {
      if (!browseSearch) return true;
      if (filterText(entry.summary, browseSearch)) return true;
      if (filterText(entry.details, browseSearch)) return true;
      if (entry.tags.some((tag) => filterText(tag, browseSearch))) return true;
      return false;
    });
  }, [browseSearch, butler]);

  useEffect(() => {
    const id = window.setInterval(() => {
      projectsQuery.reload();
      jobsQuery.reload();
      butlerQuery.reload();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [projectsQuery, jobsQuery, butlerQuery]);

  async function performDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    setActionError(null);
    try {
      if (target.kind === "butler") {
        const res = await fetch(`/api/memory/butler/${encodeURIComponent(target.id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Delete failed with ${res.status}`);
        butlerQuery.reload();
      } else if (target.kind === "project" && target.parentId) {
        const res = await fetch(
          `/api/memory/projects/${encodeURIComponent(target.parentId)}/entries/${encodeURIComponent(target.id)}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error(`Delete failed with ${res.status}`);
        projectsQuery.reload();
      } else if (target.kind === "job" && target.parentId) {
        const res = await fetch(
          `/api/memory/jobs/${encodeURIComponent(target.parentId)}/entries/${encodeURIComponent(target.id)}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error(`Delete failed with ${res.status}`);
        jobsQuery.reload();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resolveCandidate(candidateId: string, accepted: boolean) {
    setActionError(null);
    try {
      const res = await fetch("/api/memory/promotions/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, accepted })
      });
      if (!res.ok) throw new Error(`Resolve failed with ${res.status}`);
      jobsQuery.reload();
      projectsQuery.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const sectionError =
    section === "projects" ? projectsQuery.error : section === "jobs" ? jobsQuery.error : butlerQuery.error;
  const sectionLoading =
    section === "projects" ? projectsQuery.loading : section === "jobs" ? jobsQuery.loading : butlerQuery.loading;
  const activeCount =
    section === "projects" ? filteredProjects.length : section === "jobs" ? visibleJobs.length : filteredButler.length;
  const totalCount = section === "projects" ? projects.length : section === "jobs" ? jobs.length : butler.length;
  const counts = useMemo<Record<MemorySection, { active: number; total: number }>>(
    () => ({
      projects: { active: filteredProjects.length, total: projects.length },
      jobs: { active: visibleJobs.length, total: jobs.length },
      butler: { active: filteredButler.length, total: butler.length }
    }),
    [butler.length, filteredButler.length, filteredProjects.length, jobs.length, projects.length, visibleJobs.length]
  );

  useEffect(() => {
    onSummaryChange?.({ activeCount, totalCount, section, projectOptions, counts });
  }, [activeCount, counts, onSummaryChange, projectOptions, section, totalCount]);

  return (
    <div className={`dashboard ${!showHeader && !showSections ? "is-shell-layout" : ""}`}>
      {showHeader ? (
      <div className={`dashboard-head ${showTitle ? "" : "is-controls-only"}`}>
        {showTitle ? (
          <div className="dashboard-title">
            <h1>Memory</h1>
            <span className="dashboard-sub">
              {activeCount} of {totalCount} {sectionLabel(section)}
            </span>
          </div>
        ) : (
          <span className="dashboard-sub">
            {activeCount} of {totalCount} {sectionLabel(section)}
          </span>
        )}
        <div className="dashboard-controls">
          <div className="memory-search-mode" role="group" aria-label="Memory search mode">
            <button type="button" className={searchMode === "browse" ? "is-active" : ""} onClick={() => setSearchMode("browse")}>Browse</button>
            <button type="button" aria-label="Butler preview" className={searchMode === "agent" ? "is-active" : ""} onClick={() => setSearchMode("agent")}>Butler<span className="memory-preview-word"> preview</span></button>
          </div>
          <MemorySearchForm mode={searchMode} section={section} value={search} onChange={setSearch} onSubmit={submitAgentSearch} />
          <select
            className="dashboard-project-filter"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label="Filter by project"
            disabled={searchMode === "browse" && section === "butler"}
          >
            <option value="">{searchMode === "agent" ? "All projects" : section === "butler" ? "Global" : "All projects"}</option>
            {projectOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      ) : null}

      {!showSections && searchMode === "browse" ? (
        <div className="memory-mobile-sections" role="tablist" aria-label="Memory section">
          {(["projects", "jobs", "butler"] as MemorySection[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={section === option}
              className={section === option ? "is-selected" : ""}
              onClick={() => setSection(option)}
            >
              {option === "projects" ? "Projects" : option === "jobs" ? "Jobs" : "Global"}
            </button>
          ))}
        </div>
      ) : null}

      {showSections && searchMode === "browse" ? (
      <div className="segmented dashboard-sections" role="tablist" aria-label="Memory section">
        {(["projects", "jobs", "butler"] as MemorySection[]).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={section === option}
            className={section === option ? "is-selected" : ""}
            onClick={() => setSection(option)}
          >
            {option === "projects" ? "Projects" : option === "jobs" ? "Jobs" : "Butler"}
          </button>
        ))}
      </div>
      ) : null}

      {actionError ? (
        <div className="error" role="alert">
          <WarningIcon />
          <span>{actionError}</span>
        </div>
      ) : null}

      <div className="dashboard-body">
        {searchMode === "agent" ? (
          agentSearchIsStale ? (
            <div className="memory-preview-empty">
              <span className="memory-preview-empty-icon"><SearchIcon /></span>
              <h2>Search to update the preview</h2>
              <p>Your question or project scope changed. Submit it when you are ready.</p>
            </div>
          ) : (
            <AgentRetrievalPreview
              query={agentSearch?.query ?? ""}
              projectId={agentSearch?.projectId ?? ""}
              payload={previewQuery.payload}
              loading={previewQuery.loading}
              error={previewQuery.error}
              onRetry={previewQuery.reload}
            />
          )
        ) : sectionLoading && totalCount === 0 ? (
          <div className="dashboard-loading">Loading…</div>
        ) : sectionError ? (
          <div className="error" role="alert">
            <WarningIcon />
            <span>{sectionError}</span>
          </div>
        ) : (section === "jobs" ? filteredJobs.length === 0 : activeCount === 0) ? (
          <div className="dashboard-empty">
            {search
              ? `No ${section} match "${search}".`
              : section === "butler"
              ? "No butler memory yet."
              : section === "jobs"
              ? "No job memory yet."
              : "No project memory yet."}
          </div>
        ) : section === "projects" ? (
          <ul className="memory-list">
            {filteredProjects.map((project) => (
              <li key={project.projectId}>
                <ProjectCard
                  project={project}
                  query={search}
                  onDelete={(entryId, summary) =>
                    setConfirmDelete({ kind: "project", id: entryId, parentId: project.projectId, summary })
                  }
                />
              </li>
            ))}
          </ul>
        ) : section === "jobs" ? (
          <>
            <div className="memory-list-toolbar">
              <span>Job records</span>
              <div className="memory-list-filter" role="group" aria-label="Filter job memory">
                <button type="button" className={jobView === "with-memory" ? "is-active" : ""} onClick={() => setJobView("with-memory")}>With memory</button>
                <button type="button" className={jobView === "pending" ? "is-active" : ""} onClick={() => setJobView("pending")}>Pending</button>
                <button type="button" className={jobView === "all" ? "is-active" : ""} onClick={() => setJobView("all")}>All {filteredJobs.length}</button>
              </div>
            </div>
            {visibleJobs.length === 0 ? (
              <div className="dashboard-empty is-filtered">No jobs in this view. <button type="button" onClick={() => setJobView("all")}>Show all jobs</button></div>
            ) : (
              <ul className="memory-list">
                {visibleJobs.map((job) => (
                  <li key={job.threadId}>
                    <JobCard
                      job={job}
                      query={search}
                      onDeleteEntry={(entryId, summary) =>
                        setConfirmDelete({ kind: "job", id: entryId, parentId: job.threadId, summary })
                      }
                      onResolveCandidate={(candidateId, accepted) => {
                        void resolveCandidate(candidateId, accepted);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <ul className="memory-list">
            {filteredButler.map((entry) => (
              <li key={entry.id}>
                <ButlerCard
                  entry={entry}
                  query={search}
                  onDelete={(id, summary) => setConfirmDelete({ kind: "butler", id, parentId: null, summary })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete memory entry"
        body={confirmDelete ? `Permanently delete "${confirmDelete.summary}"? This cannot be undone.` : ""}
        confirmLabel="Delete"
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
