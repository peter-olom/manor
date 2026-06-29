import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getJson } from "./api";
import { SearchIcon, TrashIcon, WarningIcon } from "./icons";
import type {
  ButlerMemoryEntry,
  ButlerMemoryResponse,
  JobMemory,
  JobsResponse,
  MemorySection,
  ProjectMemory,
  ProjectsResponse
} from "../shared/memory";

const POLL_INTERVAL_MS = 5_000;
const PROJECT_ROW = 88;
const JOB_ROW = 92;
const BUTLER_ROW = 80;

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
  const visible = expanded ? project.entries : project.entries.slice(0, 3);
  const hiddenCount = project.entries.length - visible.length;

  return (
    <article className="memory-card-row">
      <header className="memory-card-head" onClick={() => setExpanded((value) => !value)}>
        <div className="memory-card-main">
          <div className="memory-card-title">{project.projectLabel}</div>
          <div className="memory-card-sub">
            {project.entries.length} entries · updated {formatTime(project.updatedAt)}
          </div>
        </div>
        <div className="memory-card-meta">
          {project.summary ? <span className="memory-summary">{project.summary}</span> : null}
          <span className="memory-card-toggle">{expanded ? "−" : "+"}</span>
        </div>
      </header>
      {expanded ? (
        <div className="memory-card-body">
          {project.entries.length === 0 ? (
            <div className="memory-empty">No entries.</div>
          ) : (
            <ul className="memory-entries">
              {visible.map((entry) => (
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
              {hiddenCount > 0 ? (
                <li className="memory-entry-more">+{hiddenCount} more</li>
              ) : null}
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

  return (
    <article className="memory-card-row">
      <header className="memory-card-head" onClick={() => setExpanded((value) => !value)}>
        <div className="memory-card-main">
          <div className="memory-card-title">
            {job.projectLabel} <span className="memory-card-id">· {job.threadId.slice(0, 8)}</span>
          </div>
          <div className="memory-card-sub">
            {job.entries.length} entries · {pendingCandidates.length} pending · updated {formatTime(job.updatedAt)}
          </div>
        </div>
        <div className="memory-card-meta">
          {job.latestCheckpoint ? <span className="memory-summary">{job.latestCheckpoint}</span> : null}
          <span className="memory-card-toggle">{expanded ? "−" : "+"}</span>
        </div>
      </header>
      {expanded ? (
        <div className="memory-card-body">
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
  const showDetails = expanded || !entry.details;
  return (
    <article className="memory-card-row">
      <header className="memory-card-head" onClick={() => setExpanded((value) => !value)}>
        <div className="memory-card-main">
          <div className="memory-card-title">{entry.summary}</div>
          <div className="memory-card-sub">
            {entry.source.replace("_", " ")} · {formatTime(entry.createdAt)}
            {entry.tags.length > 0 ? ` · ${entry.tags.length} tag${entry.tags.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <div className="memory-card-meta">
          {entry.tags.length > 0 ? <span className="memory-tag-row">{entry.tags.join(" · ")}</span> : null}
          <span className="memory-card-toggle">{expanded ? "−" : "+"}</span>
        </div>
      </header>
      {showDetails && entry.details ? (
        <div className="memory-card-body">
          <p className="memory-card-text">{entry.details}</p>
        </div>
      ) : null}
      <footer className="memory-card-foot">
        <button
          className="icon-button is-danger"
          type="button"
          onClick={() => onDelete(entry.id, entry.summary)}
          aria-label={`Delete butler memory ${entry.summary}`}
        >
          <TrashIcon />
        </button>
      </footer>
    </article>
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
  projectFilter?: string;
  onProjectFilterChange?: (projectId: string) => void;
  onSummaryChange?: (summary: MemoryDashboardSummary) => void;
}) {
  const [internalSection, setInternalSection] = useState<MemorySection>("projects");
  const [internalSearch, setInternalSearch] = useState("");
  const [internalProjectFilter, setInternalProjectFilter] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "butler" | "project" | "job"; id: string; parentId: string | null; summary: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const section = controlledSection ?? internalSection;
  const search = controlledSearch ?? internalSearch;
  const projectFilter = controlledProjectFilter ?? internalProjectFilter;
  const setSection = onSectionChange ?? setInternalSection;
  const setSearch = onSearchChange ?? setInternalSearch;
  const setProjectFilter = onProjectFilterChange ?? setInternalProjectFilter;

  const projectsQuery = useMemoryList<ProjectMemory>("/api/memory/projects", { projectId: projectFilter || null });
  const jobsQuery = useMemoryList<JobMemory>("/api/memory/jobs", { projectId: projectFilter || null });
  const butlerQuery = useMemoryList<ButlerMemoryEntry>("/api/memory/butler", { projectId: projectFilter || null });

  const projects: ProjectMemory[] = projectsQuery.items;
  const jobs: JobMemory[] = jobsQuery.items;
  const butler: ButlerMemoryEntry[] = butlerQuery.items;

  const projectOptions = useMemo(() => {
    return Array.from(
      new Map(projects.map((project) => [project.projectId, { id: project.projectId, label: project.projectLabel }])).values()
    ).sort((a, b) => a.label.localeCompare(b.label));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      if (search && !filterText(project.projectLabel, search) && !filterText(project.summary, search)) {
        if (!project.entries.some((entry) => filterText(entry.summary, search) || filterText(entry.details, search))) {
          return false;
        }
      }
      return true;
    });
  }, [projects, search]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (!search) return true;
      if (filterText(job.latestCheckpoint, search)) return true;
      if (filterText(job.nextAction, search)) return true;
      if (filterText(job.operatorGoal, search)) return true;
      if (filterText(job.requestedTask, search)) return true;
      if (job.entries.some((entry) => filterText(entry.summary, search))) return true;
      return false;
    });
  }, [jobs, search]);

  const filteredButler = useMemo(() => {
    return butler.filter((entry) => {
      if (!search) return true;
      if (filterText(entry.summary, search)) return true;
      if (filterText(entry.details, search)) return true;
      if (entry.tags.some((tag) => filterText(tag, search))) return true;
      return false;
    });
  }, [butler, search]);

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
    section === "projects" ? filteredProjects.length : section === "jobs" ? filteredJobs.length : filteredButler.length;
  const totalCount = section === "projects" ? projects.length : section === "jobs" ? jobs.length : butler.length;
  const counts = useMemo<Record<MemorySection, { active: number; total: number }>>(
    () => ({
      projects: { active: filteredProjects.length, total: projects.length },
      jobs: { active: filteredJobs.length, total: jobs.length },
      butler: { active: filteredButler.length, total: butler.length }
    }),
    [butler.length, filteredButler.length, filteredJobs.length, filteredProjects.length, jobs.length, projects.length]
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
              {activeCount} of {totalCount} {section}
            </span>
          </div>
        ) : (
          <span className="dashboard-sub">
            {activeCount} of {totalCount} {section}
          </span>
        )}
        <div className="dashboard-controls">
          <div className="search dashboard-search">
            <span className="search-icon">
              <SearchIcon />
            </span>
            <input
              type="search"
              placeholder={`Search ${section}…`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={`Search ${section}`}
            />
          </div>
          <select
            className="dashboard-project-filter"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label="Filter by project"
            disabled={section === "butler"}
          >
            <option value="">{section === "butler" ? "Global" : "All projects"}</option>
            {projectOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      ) : null}

      {showSections ? (
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
        {sectionLoading && activeCount === 0 ? (
          <div className="dashboard-loading">Loading…</div>
        ) : sectionError ? (
          <div className="error" role="alert">
            <WarningIcon />
            <span>{sectionError}</span>
          </div>
        ) : activeCount === 0 ? (
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
          <ul className="memory-list">
            {filteredJobs.map((job) => (
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
