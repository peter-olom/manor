import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { ImagePreviewModal, type PreviewMedia } from "./ImagePreviewModal";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { WorkerSwitchDialog } from "./WorkerSwitchDialog";
import { WorkerSessionControlsButton } from "./WorkerSessionControls";
import { buildProjectArtifactPreview, buildProofArtifactPreview, type ProjectArtifactPreview } from "./project-artifact-preview";
import {
  isSameWorkerRoute,
  workerModelForRoute,
  workerModelForSelection,
  workerModelLabel,
  workerModelPickerOption,
  workerModelSelectionValue,
  workerProviderLabel
} from "./worker-route";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  StatusIcon
} from "./icons";

import type { PairDetail, PairWorkerHarness } from "../shared/pairing";
import type { FileReference } from "./api";

export type WorkerItem = {
  id: string;
  type: string;
  status: string;
  text: string;
  details?: string | null;
  at: number;
  taskDurationMs?: number | null;
};

export type WorkerTurnGroup = {
  id: string;
  ordinal?: number;
  status: string;
  startedAt: number;
  completedAt: number | null;
  items: WorkerItem[];
  finalIndex: number | null;
};

export type WorkerReport = {
  turnId?: string | null;
  status: string;
  summary: string;
  details: string | null;
  evidence?: Array<{ proofRunId?: string | null; artifactId?: string | null }>;
  claims?: {
    claims?: Array<{ proofId?: string | null }>;
  } | null;
  updatedAt: number;
};

export type WorkerProofArtifact = {
  kind: string;
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  checksumSha256?: string | null;
  url: string | null;
  downloadUrl: string | null;
  availability: string;
};

export type WorkerProofRecord = {
  id: string;
  previewTitle: string;
  createdAt?: number;
  updatedAt?: number;
  verification: {
    runId: string;
    ok: boolean;
    failureKind: string;
    checkedAt: number;
    url: string;
    artifacts: WorkerProofArtifact[];
  };
  proofReviews?: Array<{ verdict: string; visibleState?: string | null; concern?: string | null }>;
};

export type WorkerChecklistItem = {
  id: string;
  text: string;
  status: string;
  note: string | null;
};

export type WorkerJobPayload = {
  payloadId: string;
  threadId: string;
  revision: number;
  kind: string;
  status: string;
  updatedAt: number;
  display: {
    summary: string;
    tags: string[];
  };
  operatorGoal: string | null;
  requestedTask: string | null;
  checklist: WorkerChecklistItem[];
  proof: string[];
  constraints: string[];
  notes: string[];
  snapshots: WorkerJobPayloadSnapshot[];
  nodes: Array<{ id: string; kind: string; parentId: string | null; summary: string; instruction: string; createdAt: number }>;
  delivery: {
    threadId: string;
    turnId: string | null;
    messageId: string | null;
  };
  report: WorkerReport | null;
};

export type WorkerJobOutputManifestEntry = {
  id: string;
  kind: "project_artifact" | "proof" | "worker_report";
  title: string;
  threadId: string;
  projectId: string;
  attemptId: string;
  scopeId: string;
  currentAttempt: boolean;
  currentScope: boolean;
  sourceTurnId: string | null;
  referenceId: string;
  logicalPath: string | null;
  createdAt: number;
  available: boolean;
  integrity: "verified" | "mismatch" | "unverified" | "missing";
  checksumSha256: string | null;
  checksumStatus: "verified" | "mismatch" | "unverified";
  integrityCheckedAt: number | null;
  status: string | null;
  fileName: string | null;
  contentType: string | null;
  previewKind: "image" | "video" | "pdf" | "markdown" | "html" | "text" | null;
  openUrl: string | null;
  downloadUrl: string | null;
};

export type WorkerJobOutputManifest = {
  jobId: string;
  projectId: string;
  currentAttemptId: string;
  currentScopeId: string;
  attempt: number;
  entries: WorkerJobOutputManifestEntry[];
  otherCurrentScopeEntries: WorkerJobOutputManifestEntry[];
  historicalEntries: WorkerJobOutputManifestEntry[];
};

export type WorkerJobPayloadSnapshot = Pick<
  WorkerJobPayload,
  "kind" | "status" | "updatedAt" | "display" | "operatorGoal" | "requestedTask" | "checklist" | "proof" | "constraints" | "notes"
> & {
  nodeId: string;
  revision: number;
  workerDirective: string;
  delivery: {
    threadId: string;
    turnId: string | null;
    messageId: string | null;
  };
};

export type WorkerTimeline = {
  turns: WorkerTurnGroup[];
  report: WorkerReport | null;
  reports: WorkerReport[];
  payload: WorkerJobPayload | null;
  outputManifest: WorkerJobOutputManifest | null;
  checklist: WorkerChecklistItem[] | null;
  fallback: WorkerItem[];
};

type WorkerPaneProps = {
  pair: PairDetail;
  timeline: WorkerTimeline;
  loading?: boolean;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  proofRecords: WorkerProofRecord[];
  onWorkerModelChange: (model: string, harness: PairWorkerHarness | null) => void;
  onWorkerEffortChange: (effort: string) => void;
  handoffPending?: boolean;
  handoffError?: string | null;
  onHandoff: (model: string, harness: PairWorkerHarness | null, effort: string | null) => Promise<boolean>;
  onOpenProviderSettings: () => void;
  onAttachAnnotatedProof: (payload: { attachment: FileReference; text: string }) => Promise<void>;
  onPreviewProjectFile: (preview: ProjectArtifactPreview) => void;
};

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.split("-").at(-1) ?? value.slice(0, 8);
}
function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
const MESSAGE_TYPES = new Set(["agentMessage", "assistant_message", "userMessage", "user_message"]);
const COMMAND_TYPES = new Set(["commandExecution", "command_execution"]);
const TOOL_TYPES = new Set(["function_call", "mcpToolCall", "mcp_tool_call", "dynamicToolCall", "dynamic_tool_call"]);
const SEARCH_TYPES = new Set(["webSearch", "web_search_call", "web_search"]);
const REASONING_TYPES = new Set(["reasoning", "context_compaction", "contextCompaction"]);
const FILE_TYPES = new Set(["fileChange", "file_change"]);

function isMessage(type: string): boolean {
  return MESSAGE_TYPES.has(type);
}
function isCommand(type: string): boolean {
  return COMMAND_TYPES.has(type);
}
function isTool(type: string): boolean {
  return TOOL_TYPES.has(type) || type.endsWith("_call");
}
function isSearch(type: string): boolean {
  return SEARCH_TYPES.has(type);
}
function isReasoning(type: string): boolean {
  return REASONING_TYPES.has(type);
}
function isFileChange(type: string): boolean {
  return FILE_TYPES.has(type);
}
function itemTypeLabel(type: string): string {
  if (isCommand(type)) return "Command";
  if (isTool(type)) return "Tool";
  if (isSearch(type)) return "Search";
  if (isReasoning(type)) return "Thinking";
  if (isFileChange(type)) return "File";
  if (isMessage(type)) return type.startsWith("agent") || type === "assistant_message" ? "Worker" : "Butler";
  return type.replace(/_/g, " ");
}
function shortText(value: string, max = 120): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
function summarizeActivity(items: WorkerItem[], durationMs: number): string {
  let commands = 0;
  let tools = 0;
  let searches = 0;
  let thinking = 0;
  let files = 0;
  let other = 0;
  for (const item of items) {
    if (isCommand(item.type)) commands += 1;
    else if (isTool(item.type)) tools += 1;
    else if (isSearch(item.type)) searches += 1;
    else if (isReasoning(item.type)) thinking += 1;
    else if (isFileChange(item.type)) files += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (thinking > 0) parts.push(`${thinking} thought${thinking === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`${other} step${other === 1 ? "" : "s"}`);
  const duration = formatDuration(durationMs);
  if (duration) parts.push(duration);
  if (parts.length === 0) return "Activity";
  return parts.join(" · ");
}
function statusBadgeClass(status: string): string {
  if (status === "failed" || status === "declined") return "is-failed";
  if (status === "started" || status === "in_progress") return "is-active";
  return "is-done";
}
function statusLabel(status: string): string {
  if (status === "started" || status === "in_progress") return "running";
  if (status === "failed") return "failed";
  if (status === "declined") return "declined";
  return status === "completed" ? "done" : status;
}
function reportToWorkerItem(report: WorkerReport): WorkerItem {
  return {
    id: `report:${report.turnId ?? "latest"}:${report.updatedAt}`,
    type: "assistant_message",
    status: "completed",
    text: report.summary,
    details: report.details,
    at: report.updatedAt
  };
}
function isButlerMessage(item: WorkerItem): boolean {
  return item.type === "userMessage" || item.type === "user_message";
}
function snapshotMatchesMessage(snapshot: WorkerJobPayloadSnapshot, item: WorkerItem, turnId: string): boolean {
  const messageId = snapshot.delivery.messageId;
  if (messageId && (item.id === messageId || item.id.endsWith(`:${messageId}`))) {
    return true;
  }
  return snapshot.delivery.turnId === turnId;
}
function payloadForMessage(payload: WorkerJobPayload | null, item: WorkerItem, turnId: string): WorkerPayloadDetailsView | null {
  if (!payload || !isButlerMessage(item)) {
    return null;
  }
  const snapshots = [...(payload.snapshots ?? [])].sort((left, right) => left.updatedAt - right.updatedAt);
  const exact = snapshots.filter((snapshot) => snapshotMatchesMessage(snapshot, item, turnId)).at(-1);
  if (exact) {
    return exact;
  }
  const temporal = snapshots
    .filter((snapshot) => snapshot.updatedAt <= item.at + 10_000)
    .at(-1);
  if (temporal) {
    return temporal;
  }

  return payload.delivery.turnId ? null : payload;
}
function messageSpeaker(item: WorkerItem): "Butler" | "Worker" {
  return isButlerMessage(item) ? "Butler" : "Worker";
}
function messageClass(item: WorkerItem): string {
  return isButlerMessage(item) ? "is-butler" : "is-codex";
}
function payloadLabel(tag: string): string {
  if (tag === "checklist") return "Checklist";
  if (tag === "proof") return "Proof";
  if (tag === "constraints") return "Constraints";
  if (tag === "notes") return "Notes";
  return tag;
}
type WorkerPayloadDetailsView = Pick<
  WorkerJobPayload,
  "display" | "checklist" | "proof" | "constraints" | "notes"
> & { report?: WorkerReport | null };

function payloadSectionText(payload: WorkerPayloadDetailsView, tag: string): string {
  if (tag === "proof") return payload.proof.length ? payload.proof.map((item) => `- ${item}`).join("\n") : "No proof requested.";
  if (tag === "constraints") return payload.constraints.length ? payload.constraints.map((item) => `- ${item}`).join("\n") : "No constraints.";
  if (tag === "notes") return payload.notes.length ? payload.notes.map((item) => `- ${item}`).join("\n") : "No notes.";
  return payload.display.summary;
}
function checklistStatusLabel(status: string): string {
  if (status === "accepted") return "Accepted";
  if (status === "waived") return "Waived";
  if (status === "rejected") return "Rejected";
  return "Pending";
}
function checklistStatusClass(status: string): string {
  if (status === "accepted" || status === "waived") return "is-accepted";
  if (status === "rejected") return "is-rejected";
  return "is-pending";
}
const WorkerPayloadChecklist = memo(function WorkerPayloadChecklist({ items }: { items: WorkerChecklistItem[] }) {
  if (items.length === 0) {
    return <p className="worker-payload-empty">No checklist items.</p>;
  }

  return (
    <ol className="worker-checklist">
      {items.map((item) => {
        const label = checklistStatusLabel(item.status);
        const stateClass = checklistStatusClass(item.status);
        const checked = stateClass === "is-accepted";
        return (
          <li key={item.id} className={`worker-checklist-item ${stateClass}`}>
            <span className="worker-checklist-marker" aria-hidden="true">
              {checked ? "✓" : item.status === "rejected" ? "!" : null}
            </span>
            <div className="worker-checklist-copy">
              <span className="worker-checklist-text">{item.text}</span>
              <span className="sr-only">{label}</span>
              {item.note ? <span className="worker-checklist-note">{item.note}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
});

const WorkerPayloadDetails = memo(function WorkerPayloadDetails({
  payload,
  checklist
}: {
  payload: WorkerPayloadDetailsView;
  checklist: WorkerChecklistItem[] | null;
}) {
  const tags = useMemo(() => {
    const base = payload.display.tags.length > 0 ? payload.display.tags : ["checklist", "proof", "constraints", "notes"];
    const hasChecklist = (checklist ?? payload.checklist).length > 0;
    const visibleTags = base.filter((tag) => tag !== "report");
    return hasChecklist ? ["checklist", ...visibleTags.filter((tag) => tag !== "checklist")] : visibleTags;
  }, [checklist, payload.checklist, payload.display.tags]);
  const [activeTag, setActiveTag] = useState(tags[0] ?? "checklist");
  const selectedTag = tags.includes(activeTag) ? activeTag : tags[0] ?? "checklist";
  const visibleChecklist = checklist ?? payload.checklist;

  return (
    <details className="worker-payload">
      <summary>
        <span className="worker-payload-chevron" aria-hidden="true">
          <span className="worker-payload-chevron-closed"><ChevronRightIcon /></span>
          <span className="worker-payload-chevron-open"><ChevronDownIcon /></span>
        </span>
        <span className="worker-payload-title">Job details</span>
        <span className="worker-payload-summary">{payload.display.summary}</span>
      </summary>
      <div className="worker-payload-panel">
        <div className="worker-payload-tabs" role="tablist" aria-label="Job payload sections">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              role="tab"
              aria-selected={selectedTag === tag}
              className={selectedTag === tag ? "is-selected" : ""}
              onClick={() => setActiveTag(tag)}
            >
              {payloadLabel(tag)}
            </button>
          ))}
        </div>
        {selectedTag === "checklist" ? (
          <WorkerPayloadChecklist items={visibleChecklist} />
        ) : (
          <Markdown className="worker-payload-body" text={payloadSectionText(payload, selectedTag)} />
        )}
      </div>
    </details>
  );
});

function outputKindLabel(kind: WorkerJobOutputManifestEntry["kind"]): string {
  if (kind === "project_artifact") return "Artifact";
  if (kind === "worker_report") return "Report";
  return "Proof";
}
function outputIntegrityLabel(entry: WorkerJobOutputManifestEntry): string {
  if (entry.kind !== "project_artifact" && entry.available) return "Not checksum-backed";
  if (entry.integrity === "verified") return "Checksum verified";
  if (entry.integrity === "mismatch") return "Checksum mismatch";
  if (entry.integrity === "missing") return "Missing";
  return "Unverified";
}
function outputOutcome(entry: WorkerJobOutputManifestEntry): { label: string; className: string } | null {
  if (!entry.status) return null;
  if (entry.kind === "proof") {
    return entry.status === "passed"
      ? { label: "Proof passed", className: "is-neutral" }
      : { label: `Proof ${entry.status}`, className: "is-negative" };
  }
  if (entry.kind === "worker_report") {
    return {
      label: `Report ${entry.status}`,
      className: entry.status === "blocked" || entry.status === "failed" ? "is-negative" : "is-neutral"
    };
  }
  return null;
}
function outputAttemptLabel(entry: WorkerJobOutputManifestEntry, currentAttemptId: string, currentAttempt: number): string {
  if (entry.attemptId === currentAttemptId) return String(currentAttempt);
  return entry.attemptId.match(/-(\d+)$/)?.[1] ?? shortId(entry.attemptId);
}
export function outputArtifactPreview(entry: WorkerJobOutputManifestEntry): ProjectArtifactPreview | null {
  if (!entry.openUrl || !entry.fileName || !entry.contentType) return null;
  const input = { id: entry.referenceId, name: entry.fileName, mimeType: entry.contentType, url: entry.openUrl };
  if (entry.kind === "project_artifact") return buildProjectArtifactPreview(input);
  if (entry.kind === "proof") return buildProofArtifactPreview(input);
  return null;
}
function WorkerOutputEntryList({ entries, attempt, currentAttemptId, onOpenArtifact }: { entries: WorkerJobOutputManifestEntry[]; attempt: number; currentAttemptId: string; onOpenArtifact?: (entry: WorkerJobOutputManifestEntry) => void }) {
  const sorted = [...entries].sort((left, right) => left.createdAt - right.createdAt);
  const INLINE_PREVIEW_KINDS = new Set(["markdown", "pdf", "text", "html"]);
  return <ol className="worker-output-manifest-list">
    {sorted.map((entry) => {
      const outcome = outputOutcome(entry);
      const useInlinePreview = entry.previewKind && INLINE_PREVIEW_KINDS.has(entry.previewKind) && onOpenArtifact && outputArtifactPreview(entry);
      return <li key={entry.id} className={`worker-output-manifest-entry${entry.available ? "" : " is-missing"}`}>
        <div className="worker-output-manifest-entry-head">
          <span className="worker-output-kind">{outputKindLabel(entry.kind)}</span>
          <strong>{entry.title}</strong>
          <span className={`worker-output-availability ${entry.kind === "proof" && entry.available ? "" : entry.available ? "is-available" : "is-missing"}`}>
            {entry.kind === "proof" && entry.available ? "Record available" : entry.available ? "Available" : "Missing"}
          </span>
          <span className={`worker-output-integrity ${entry.kind !== "project_artifact" && entry.available ? "is-record" : `is-${entry.integrity}`}`}>{outputIntegrityLabel(entry)}</span>
          {outcome ? <span className={`worker-output-outcome ${outcome.className}`}>{outcome.label}</span> : null}
        </div>
        {entry.available && (entry.openUrl || entry.downloadUrl) ? (
          <div className="worker-output-manifest-actions">
            {entry.previewKind && entry.openUrl ? (
              useInlinePreview ? (
                <button type="button" className="worker-output-open-button" onClick={() => onOpenArtifact?.(entry)} aria-label={`Open ${entry.title}`}>Open</button>
              ) : (
                <a href={entry.openUrl} target="_blank" rel="noreferrer" aria-label={`Open ${entry.title}`}>Open</a>
              )
            ) : null}
            {entry.downloadUrl ? <a href={entry.downloadUrl} download aria-label={`Download ${entry.title}`}>Download</a> : null}
            {!entry.previewKind && entry.downloadUrl ? <span className="worker-output-download-only">Download only</span> : null}
          </div>
        ) : null}
        <details className="worker-output-manifest-provenance">
          <summary>Provenance</summary>
          <div className="worker-output-manifest-meta">
            <span title={entry.referenceId}>Ref {shortId(entry.referenceId)}</span>
            <span title={entry.attemptId}>Attempt {outputAttemptLabel(entry, currentAttemptId, attempt)}</span>
            {entry.sourceTurnId ? <span title={entry.sourceTurnId}>Turn {shortId(entry.sourceTurnId)}</span> : null}
            {entry.logicalPath ? <span title={entry.logicalPath}>{entry.logicalPath}</span> : entry.fileName ? <span title={entry.fileName}>{entry.fileName}</span> : null}
            {entry.contentType ? <span title={entry.contentType}>{entry.contentType}</span> : null}
            {entry.checksumSha256 ? <span title={`SHA-256 ${entry.checksumSha256}`}>sha256 {entry.checksumSha256.slice(0, 10)}</span> : null}
            {entry.kind === "project_artifact" && entry.integrityCheckedAt ? (
              <span title={new Date(entry.integrityCheckedAt).toISOString()}>Integrity checked {new Date(entry.integrityCheckedAt).toLocaleString()}</span>
            ) : null}
          </div>
        </details>
      </li>;
    })}
  </ol>;
}
const WorkerOutputPinnedBar = memo(function WorkerOutputPinnedBar({ manifest, onOpenArtifact }: { manifest: WorkerJobOutputManifest; onOpenArtifact: (entry: WorkerJobOutputManifestEntry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const allEntries = [
    ...manifest.entries,
    ...(manifest.otherCurrentScopeEntries ?? []),
    ...(manifest.historicalEntries ?? [])
  ];
  const sortedEntries = [...allEntries].sort((a, b) => b.createdAt - a.createdAt);
  const total = sortedEntries.length;
  return (
    <div className={`worker-output-pinned ${expanded ? "is-expanded" : ""}`}>
      <button type="button" className="worker-output-pinned-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="worker-output-pinned-label">
          <span className="worker-output-pinned-dot" />
          Task outputs
        </span>
        <span className="worker-output-pinned-count">{total} available</span>
        <span className="worker-output-pinned-chevron">{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
      </button>
      {expanded ? (
        <div className="worker-output-pinned-list">
          {total === 0 ? <p className="worker-output-pinned-empty">No outputs yet.</p> : null}
          {sortedEntries.map((entry) => (
            <WorkerOutputPinnedItem key={entry.id} entry={entry} onOpenArtifact={onOpenArtifact} isHistorical={entry.currentScope === false} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const WorkerOutputPinnedItem = memo(function WorkerOutputPinnedItem({ entry, onOpenArtifact, isHistorical = false }: { entry: WorkerJobOutputManifestEntry; onOpenArtifact: (entry: WorkerJobOutputManifestEntry) => void; isHistorical?: boolean }) {
  return (
    <div className={`worker-output-pinned-item ${isHistorical ? "is-historical" : ""}`}>
      <span className="worker-output-pinned-item-title">{entry.title}</span>
      <span className="worker-output-pinned-item-time">{formatTime(entry.createdAt)}</span>
      <span className="worker-output-pinned-item-kind">{entry.kind.replace("_", " ")}</span>
      {entry.previewKind && entry.openUrl ? (
        <button type="button" className="worker-output-pinned-item-open" onClick={() => onOpenArtifact(entry)}>Open</button>
      ) : null}
      {entry.downloadUrl ? <a href={entry.downloadUrl} className="worker-output-pinned-item-download" download>Download</a> : null}
    </div>
  );
});

export const WorkerJobOutputManifestPanel = memo(function WorkerJobOutputManifestPanel({ manifest, onOpenArtifact }: { manifest: WorkerJobOutputManifest | null; onOpenArtifact?: (entry: WorkerJobOutputManifestEntry) => void }) {
  if (!manifest) return null;
  const entries = manifest.entries.filter((entry) => entry.currentScope !== false);
  const otherEntries = (manifest.otherCurrentScopeEntries ?? []).filter((entry) => entry.currentScope !== false);
  const historicalEntries = (manifest.historicalEntries ?? []).filter((entry) => !entry.currentScope);
  return (
    <section className="worker-output-manifest" aria-label="Current task outputs">
      <header className="worker-output-manifest-head">
        <div>
          <h3>Current task outputs</h3>
          <p title={`Job ${manifest.jobId} · Project ${manifest.projectId} · ${manifest.currentAttemptId} · ${manifest.currentScopeId ?? "legacy scope"}`}>
            Job {shortId(manifest.jobId)} · Attempt {manifest.attempt}
          </p>
        </div>
        <span>{entries.length} output{entries.length === 1 ? "" : "s"}</span>
      </header>
      {entries.length === 0 ? (
        <p className="worker-output-manifest-empty">No outputs claimed by the current Worker report.</p>
      ) : (
        <WorkerOutputEntryList entries={entries} attempt={manifest.attempt} currentAttemptId={manifest.currentAttemptId} onOpenArtifact={onOpenArtifact} />
      )}
      {otherEntries.length > 0 ? <details className="worker-output-history"><summary>Other outputs from this task ({otherEntries.length})</summary><WorkerOutputEntryList entries={otherEntries} attempt={manifest.attempt} currentAttemptId={manifest.currentAttemptId} onOpenArtifact={onOpenArtifact} /></details> : null}
      {historicalEntries.length > 0 ? <details className="worker-output-history"><summary>Earlier task outputs ({historicalEntries.length})</summary><WorkerOutputEntryList entries={historicalEntries} attempt={manifest.attempt} currentAttemptId={manifest.currentAttemptId} onOpenArtifact={onOpenArtifact} /></details> : null}
    </section>
  );
});

function proofStatusLabel(proof: WorkerProofRecord): string {
  const review = proof.proofReviews?.at(-1);
  if (review?.verdict) return review.verdict;
  return proof.verification.ok ? "recorded" : proof.verification.failureKind;
}
function proofArtifactLabel(artifact: WorkerProofArtifact): string {
  return artifact.label || artifact.fileName || artifact.kind;
}
export function isPreviewableProofImage(artifact: WorkerProofArtifact): boolean {
  return artifact.availability === "available"
    && Boolean(artifact.url)
    && (artifact.kind === "screenshot" || artifact.contentType.toLowerCase().startsWith("image/"));
}
export function isPreviewableProofVideo(artifact: WorkerProofArtifact): boolean {
  return artifact.availability === "available"
    && Boolean(artifact.url)
    && (artifact.kind === "video" || artifact.contentType.toLowerCase().startsWith("video/"));
}
function isPreviewableProofMedia(artifact: WorkerProofArtifact): boolean {
  return isPreviewableProofImage(artifact) || isPreviewableProofVideo(artifact);
}
function proofPreviewMedia(artifact: WorkerProofArtifact, name?: string): PreviewMedia {
  return {
    name: name || artifact.fileName || artifact.label || (isPreviewableProofVideo(artifact) ? "Proof video" : "Proof screenshot"),
    url: artifact.url ?? "",
    kind: isPreviewableProofVideo(artifact) ? "video" : "image",
    downloadUrl: artifact.downloadUrl ?? artifact.url
  };
}
type OpenProofPreview = (media: PreviewMedia, gallery?: PreviewMedia[]) => void;

type WorkerProofArtifactEntry = {
  proof: WorkerProofRecord;
  artifact: WorkerProofArtifact;
  index: number;
  aliases: string[];
};

const BROWSER_PROOF_KINDS = new Set(["manifest", "screenshot", "video", "trace", "html"]);

function isBrowserProof(proof: WorkerProofRecord): boolean {
  return proof.verification.artifacts.some((artifact) => BROWSER_PROOF_KINDS.has(artifact.kind));
}
function proofEntryKey(entry: WorkerProofArtifactEntry): string {
  return proofArtifactKey(entry.proof.id, entry.artifact, entry.index);
}
function proofEntryLabel(entry: WorkerProofArtifactEntry): string {
  const label = proofArtifactLabel(entry.artifact);
  return entry.aliases.length > 0 ? `${label} · ${entry.aliases.join(" · ")}` : label;
}
function proofEntryIdentity(entry: WorkerProofArtifactEntry): string | null {
  const checksum = entry.artifact.checksumSha256?.trim().toLowerCase();
  if (checksum) return `sha256:${checksum}`;
  const url = entry.artifact.url?.split("?", 1)[0]?.trim();
  return url ? `url:${url}` : null;
}
function compareProofEntries(left: WorkerProofArtifactEntry, right: WorkerProofArtifactEntry): number {
  return proofTimestamp(left.proof) - proofTimestamp(right.proof)
    || left.index - right.index
    || proofEntryKey(left).localeCompare(proofEntryKey(right));
}
function proofGroupStatus(proofs: WorkerProofRecord[]): string {
  const reviews = proofs.map((proof) => proof.proofReviews?.at(-1)).filter(Boolean);
  if (reviews.some((review) => review?.verdict === "failed")) return "failed";
  if (reviews.some((review) => review?.verdict === "unclear")) return "unclear";
  if (reviews.length > 0 && reviews.every((review) => review?.verdict === "credible")) return "credible";
  const failedProof = proofs.find((proof) => !proof.verification.ok);
  return failedProof?.verification.failureKind || "recorded";
}
function proofGroupTitle(proofs: WorkerProofRecord[]): string {
  const browserProof = [...proofs]
    .filter(isBrowserProof)
    .sort((left, right) => proofTimestamp(right) - proofTimestamp(left))[0];
  return browserProof?.previewTitle || proofs[0]?.previewTitle || "Worker evidence";
}
function proofArtifactKey(proofId: string, artifact: WorkerProofArtifact, index: number): string {
  const identity = artifact.url || artifact.downloadUrl || `${artifact.kind}:${artifact.fileName}:${artifact.label}`;
  return `${proofId}:${identity}:${index}`;
}
const WorkerProofMediaSection = memo(function WorkerProofMediaSection({
  label,
  runId,
  entries,
  gallery,
  onPreviewImage
}: {
  label: string | null;
  runId: string | null;
  entries: WorkerProofArtifactEntry[];
  gallery: PreviewMedia[];
  onPreviewImage: OpenProofPreview;
}) {
  const screenshots = entries.filter(({ artifact }) => isPreviewableProofImage(artifact));
  const videos = entries.filter(({ artifact }) => isPreviewableProofVideo(artifact));
  return (
    <section className="worker-proof-run">
      {label ? (
        <header className="worker-proof-run-head">
          <span>{label}</span>
          {runId ? <code>{runId}</code> : null}
        </header>
      ) : null}
      {screenshots.length > 0 ? (
        <div className="worker-proof-shots">
          {screenshots.map((entry) => {
            const media = proofPreviewMedia(entry.artifact, proofEntryLabel(entry));
            return (
              <button
                key={proofEntryKey(entry)}
                type="button"
                title={proofEntryLabel(entry)}
                onClick={() => onPreviewImage(media, gallery)}
              >
                <img src={entry.artifact.url ?? undefined} alt={proofEntryLabel(entry)} loading="lazy" decoding="async" />
              </button>
            );
          })}
        </div>
      ) : null}
      {videos.length > 0 ? (
        <div className="worker-proof-videos">
          {videos.map((entry) => {
            const media = proofPreviewMedia(entry.artifact, proofEntryLabel(entry));
            return (
              <figure key={proofEntryKey(entry)}>
                <video src={media.url} controls playsInline preload="none" aria-label={proofEntryLabel(entry)} />
                <figcaption>
                  <span>{proofEntryLabel(entry)}</span>
                  <span className="worker-proof-video-actions">
                    <button type="button" onClick={() => onPreviewImage(media, gallery)}>Expand</button>
                    <a href={media.url} target="_blank" rel="noreferrer">Open</a>
                    <a href={media.downloadUrl ?? media.url} download>Download</a>
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}
      <div className="worker-proof-artifacts">
        {entries.map((entry) => (
          <span key={`${proofEntryKey(entry)}:chip`} title={`${entry.proof.previewTitle || "Proof"} · ${entry.proof.verification.runId}`}>
            {proofEntryLabel(entry)}{entry.artifact.availability === "available" ? "" : ` · ${entry.artifact.availability}`}
          </span>
        ))}
      </div>
    </section>
  );
});

const WorkerProofBundleList = memo(function WorkerProofBundleList({
  proofs,
  onPreviewImage
}: {
  proofs: WorkerProofRecord[];
  onPreviewImage: OpenProofPreview;
}) {
  if (proofs.length === 0) return null;
  const entries: WorkerProofArtifactEntry[] = proofs.flatMap((proof) =>
    proof.verification.artifacts.map((artifact, index) => ({ proof, artifact, index, aliases: [] }))
  );
  const browserProofs = [...proofs].filter(isBrowserProof).sort((left, right) => proofTimestamp(left) - proofTimestamp(right));
  const browserProofIds = new Set(browserProofs.map((proof) => proof.id));
  const browserEntries = browserProofs.flatMap((proof) => entries.filter((entry) => entry.proof.id === proof.id));
  const additionalEntries = entries.filter((entry) => !browserProofIds.has(entry.proof.id)).sort(compareProofEntries);
  const linkedCopyKeys = new Set<string>();
  for (const entry of additionalEntries.filter(({ artifact }) => isPreviewableProofImage(artifact))) {
    const identity = proofEntryIdentity(entry);
    if (!identity) continue;
    const matches = browserEntries.filter((candidate) =>
      isPreviewableProofImage(candidate.artifact) && proofEntryIdentity(candidate) === identity
    );
    if (matches.length !== 1) continue;
    linkedCopyKeys.add(proofEntryKey(entry));
    const alias = entry.proof.previewTitle || proofArtifactLabel(entry.artifact);
    if (!matches[0]!.aliases.includes(alias)) matches[0]!.aliases.push(alias);
  }
  const visibleAdditionalEntries = additionalEntries.filter((entry) => !linkedCopyKeys.has(proofEntryKey(entry)));
  const mediaEntries = [...browserEntries, ...visibleAdditionalEntries]
    .filter(({ artifact }) => isPreviewableProofMedia(artifact))
    .sort(compareProofEntries);
  const gallery = mediaEntries.map((entry) => proofPreviewMedia(entry.artifact, proofEntryLabel(entry)));
  const screenshots = mediaEntries.filter(({ artifact }) => isPreviewableProofImage(artifact));
  const videos = mediaEntries.filter(({ artifact }) => isPreviewableProofVideo(artifact));
  const status = proofGroupStatus(proofs);
  const failed = status === "failed" || proofs.some((proof) => !proof.verification.ok);
  const unclear = status === "unclear";
  const reviewStates = [...new Set(proofs.map((proof) => proof.proofReviews?.at(-1)?.visibleState?.trim()).filter((value): value is string => Boolean(value)))];
  const runCount = browserProofs.length;
  const summaryParts = [
    `${entries.length} artifact${entries.length === 1 ? "" : "s"}`,
    screenshots.length > 0 ? `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"}` : "",
    videos.length > 0 ? `${videos.length} video${videos.length === 1 ? "" : "s"}` : "",
    linkedCopyKeys.size > 0 ? `${linkedCopyKeys.size} linked cop${linkedCopyKeys.size === 1 ? "y" : "ies"}` : ""
  ].filter(Boolean);
  return (
    <section className="worker-proof-bundles" aria-label="Proof attached to conversation">
      <header className="worker-proof-head">
        <span>Evidence attached</span>
        <span>{runCount > 0 ? `${runCount} browser run${runCount === 1 ? "" : "s"}` : `${proofs.length} source${proofs.length === 1 ? "" : "s"}`}</span>
      </header>
      <article className={`worker-proof-card ${failed ? "is-failed" : unclear ? "is-unclear" : "is-ok"}`}>
        <div className="worker-proof-card-head">
          <div>
            <h3>{proofGroupTitle(proofs)}</h3>
            <p>{summaryParts.join(" · ")}</p>
          </div>
          <span>{status}</span>
        </div>
        {browserProofs.map((proof, index) => (
          <WorkerProofMediaSection
            key={proof.id}
            label={browserProofs.length > 1 ? `Browser run ${index + 1}` : null}
            runId={browserProofs.length > 1 ? proof.verification.runId : null}
            entries={browserEntries.filter((entry) => entry.proof.id === proof.id)}
            gallery={gallery}
            onPreviewImage={onPreviewImage}
          />
        ))}
        {visibleAdditionalEntries.length > 0 ? (
          <WorkerProofMediaSection
            label={browserProofs.length > 0 ? "Additional evidence" : null}
            runId={null}
            entries={visibleAdditionalEntries}
            gallery={gallery}
            onPreviewImage={onPreviewImage}
          />
        ) : null}
        {proofs.length > 1 ? (
          <details className="worker-proof-sources">
            <summary>{proofs.length} source records</summary>
            <div>
              {proofs.map((proof) => (
                <p key={proof.id}>
                  <span>{proof.previewTitle || "Proof bundle"}</span>
                  <code>{proof.verification.runId}</code>
                  <em>{proofStatusLabel(proof)}</em>
                </p>
              ))}
            </div>
          </details>
        ) : null}
        {reviewStates.map((reviewState) => <p key={reviewState} className="worker-proof-review">{reviewState}</p>)}
      </article>
    </section>
  );
});

function resolveTurnDurationMs(turn: WorkerTurnGroup, finalItem: WorkerItem | null, items: WorkerItem[]): number {
  if (finalItem && finalItem.at >= turn.startedAt) return finalItem.at - turn.startedAt;
  const lastAt = items.reduce((latest, item) => Math.max(latest, item.at), turn.startedAt);
  return Math.max(0, lastAt - turn.startedAt);
}
type WorkerMessageRowProps = {
  item: WorkerItem;
  streaming?: boolean;
  payload?: WorkerJobPayload | null;
  checklist?: WorkerChecklistItem[] | null;
};

const WorkerMessageRow = memo(function WorkerMessageRow({ item, streaming, payload, checklist }: WorkerMessageRowProps) {
  const showPayload = isButlerMessage(item) && payload;
  return (
    <article className={`worker-message ${messageClass(item)} ${streaming ? "is-streaming" : ""}`}>
      <header className="worker-message-head">
        <span className="worker-message-label">{messageSpeaker(item)}</span>
        <time className="worker-message-time">{formatTime(item.at)}</time>
      </header>
      <Markdown className="worker-message-body" text={item.text} />
      {item.details?.trim() ? (
        <details className="worker-report-details">
          <summary>Report details</summary>
          <Markdown className="worker-message-body is-report-details" text={item.details} />
        </details>
      ) : null}
      {showPayload ? <WorkerPayloadDetails payload={payload} checklist={checklist ?? null} /> : null}
    </article>
  );
});

type WorkerCompactRowProps = {
  item: WorkerItem;
};

const WorkerCompactRow = memo(function WorkerCompactRow({ item }: WorkerCompactRowProps) {
  const label = itemTypeLabel(item.type);
  const preview = shortText(item.text, 140);
  return (
    <details className={`worker-row-compact ${statusBadgeClass(item.status)}`} {...(item.status === "failed" ? { open: true } : {})}>
      <summary>
        <span className="worker-row-chevron" aria-hidden="true">
          <span className="worker-row-chevron-closed"><ChevronRightIcon /></span>
          <span className="worker-row-chevron-open"><ChevronDownIcon /></span>
        </span>
        <span className="worker-row-label">{label}</span>
        <span className="worker-row-text">{preview || "—"}</span>
        <span className="worker-row-status">{statusLabel(item.status)}</span>
      </summary>
      <pre className="worker-row-body">{item.text}</pre>
    </details>
  );
});

type WorkerActivityListProps = {
  items: WorkerItem[];
};

const WorkerActivityList = memo(function WorkerActivityList({ items }: WorkerActivityListProps) {
  return (
    <div className="worker-activity-list" role="list">
      {items.map((item) => (
        <div role="listitem" key={item.id}>
          <WorkerCompactRow item={item} />
        </div>
      ))}
    </div>
  );
});

type WorkerActiveTurnProps = {
  turn: WorkerTurnGroup;
  index: number;
  payload: WorkerJobPayload | null;
  checklist: WorkerChecklistItem[] | null;
  proofs: WorkerProofRecord[];
  onPreviewImage: OpenProofPreview;
};

const WorkerActiveTurn = memo(function WorkerActiveTurn({ turn, index, payload, checklist, proofs, onPreviewImage }: WorkerActiveTurnProps) {
  const sorted = useMemo(() => [...turn.items].sort((a, b) => a.at - b.at), [turn.items]);
  const ordinal = turn.ordinal ?? index + 1;
  return (
    <section className="worker-turn is-active" aria-label={`Worker turn ${ordinal} in progress`}>
      <header className="worker-turn-head">
        <span className="worker-turn-dot" aria-hidden="true" />
        <span className="worker-turn-title">Worker turn {ordinal}</span>
        <span className="worker-turn-status">in progress</span>
        <time className="worker-turn-time">{formatTime(turn.startedAt)}</time>
      </header>
      <div className="worker-turn-items">
        {sorted.map((item) =>
          isMessage(item.type) ? (
            <WorkerMessageRow key={item.id} item={item} payload={payloadForMessage(payload, item, turn.id)} checklist={checklist} streaming={item.status === "started"} />
          ) : (
            <WorkerCompactRow key={item.id} item={item} />
          )
        )}
      </div>
      <WorkerProofBundleList proofs={proofs} onPreviewImage={onPreviewImage} />
    </section>
  );
});

type WorkerCompletedTurnProps = {
  turn: WorkerTurnGroup;
  index: number;
  payload: WorkerJobPayload | null;
  checklist: WorkerChecklistItem[] | null;
  proofs: WorkerProofRecord[];
  onPreviewImage: OpenProofPreview;
};

const WorkerCompletedTurn = memo(function WorkerCompletedTurn({ turn, index, payload, checklist, proofs, onPreviewImage }: WorkerCompletedTurnProps) {
  const sorted = useMemo(() => [...turn.items].sort((a, b) => a.at - b.at), [turn.items]);
  const finalIndex = turn.finalIndex;
  const finalItem = finalIndex !== null ? sorted[finalIndex] ?? null : null;
  const visibleMessageIds = new Set<string>();
  if (finalItem) visibleMessageIds.add(finalItem.id);
  for (const item of sorted) {
    if (isButlerMessage(item)) visibleMessageIds.add(item.id);
  }
  const visibleMessages = sorted.filter((item) => visibleMessageIds.has(item.id));
  const supporting = sorted.filter((item) => !visibleMessageIds.has(item.id));
  const leadingMessages = finalItem ? visibleMessages.filter((item) => item.id !== finalItem.id) : visibleMessages;
  const durationMs = resolveTurnDurationMs(turn, finalItem, sorted);
  const activityLabel = summarizeActivity(supporting, 0);
  const failed = turn.status === "failed";
  const stopped = turn.status === "interrupted" || turn.status === "cancelled";
  const terminalLabel = failed ? "failed" : stopped ? "stopped" : "complete";
  const defaultOpen = failed || stopped || !finalItem;
  const ordinal = turn.ordinal ?? index + 1;

  return (
    <section className={`worker-turn is-complete${failed || stopped ? " is-failed" : ""}`} aria-label={`Worker turn ${ordinal} ${terminalLabel}`}>
      <header className="worker-turn-head">
        <span className="worker-turn-title">Worker turn {ordinal}</span>
        <span className={`worker-turn-status ${failed || stopped ? "is-failed" : "is-done"}`}>{terminalLabel}</span>
        <time className="worker-turn-time">{formatTime(turn.startedAt)}</time>
        {durationMs > 0 ? <span className="worker-turn-duration">{formatDuration(durationMs)}</span> : null}
      </header>
      {leadingMessages.map((item) => <WorkerMessageRow key={item.id} item={item} payload={payloadForMessage(payload, item, turn.id)} checklist={checklist} />)}
      {supporting.length > 0 ? (
        <details className="worker-activity" {...(defaultOpen ? { open: true } : {})}>
          <summary>
            <span>{activityLabel}</span>
          </summary>
          <WorkerActivityList items={supporting} />
        </details>
      ) : null}
      {finalItem ? <WorkerMessageRow key={finalItem.id} item={finalItem} payload={payloadForMessage(payload, finalItem, turn.id)} checklist={checklist} /> : null}
      <WorkerProofBundleList proofs={proofs} onPreviewImage={onPreviewImage} />
    </section>
  );
});

export const WorkerTurnView = memo(function WorkerTurnView({
  turn,
  index,
  payload,
  checklist,
  proofs,
  onPreviewImage
}: {
  turn: WorkerTurnGroup;
  index: number;
  payload: WorkerJobPayload | null;
  checklist: WorkerChecklistItem[] | null;
  proofs: WorkerProofRecord[];
  onPreviewImage: OpenProofPreview;
}) {
  if (turn.completedAt === null) {
    return <WorkerActiveTurn turn={turn} index={index} payload={payload} checklist={checklist} proofs={proofs} onPreviewImage={onPreviewImage} />;
  }
  return <WorkerCompletedTurn turn={turn} index={index} payload={payload} checklist={checklist} proofs={proofs} onPreviewImage={onPreviewImage} />;
});

const FallbackRow = memo(function FallbackRow({ row }: { row: WorkerItem }) {
  return (
    <article className="worker-item">
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
  );
});

export function WorkerPane({ pair, timeline, loading = false, hasMore = false, loadingOlder = false, onLoadOlder, proofRecords, onWorkerModelChange, onWorkerEffortChange, handoffPending = false, handoffError = null, onHandoff, onOpenProviderSettings, onAttachAnnotatedProof, onPreviewProjectFile }: WorkerPaneProps) {
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [previewGallery, setPreviewGallery] = useState<PreviewMedia[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const onOpenArtifact = useCallback((entry: WorkerJobOutputManifestEntry) => {
    const preview = outputArtifactPreview(entry);
    if (preview) onPreviewProjectFile(preview);
  }, [onPreviewProjectFile]);

  useEffect(() => {
    setSwitchOpen(false);
  }, [pair.id, pair.worker?.threadId]);

  if (!pair.worker) {
    const worker = pair.compose.worker;
    const options = worker.availableEfforts;
    const pickerModels = worker.availableModels.map(workerModelPickerOption);
    const configuredModel = workerModelForRoute(worker.availableModels, worker.model, worker.harness) ?? worker.availableModels[0] ?? null;
    const model = configuredModel ? workerModelSelectionValue(worker.availableModels, configuredModel.id, configuredModel.harness) : null;
    const effort = worker.effort ?? null;
    return (
      <section className="pane" aria-label="Worker lane">
        <div className="pane-head">
          <div className="pane-head-info">
            <h2>Worker</h2>
            <span className="pane-sub">No worker attached</span>
          </div>
          <div className="worker-controls" aria-label="Worker settings">
            <span className="worker-controls-label">Next worker</span>
            {worker.availableModels.length > 0 ? (
              <ModelPicker
                label="Model"
                value={model}
                options={pickerModels}
                compact
                anchor="below"
                className="worker-model"
                onChange={(selectionId) => {
                  const selected = workerModelForSelection(worker.availableModels, selectionId);
                  if (selected) onWorkerModelChange(selected.id, selected.harness ?? null);
                }}
              />
            ) : null}
            {options.length > 0 ? (
              <BudgetSegmented
                label="Thinking"
                value={effort}
                options={options}
                onChange={onWorkerEffortChange}
                className="worker-budget"
              />
            ) : null}
          </div>
        </div>
        <div className="empty-state">
          <h2>{worker.availableModels.length > 0 ? "No worker attached" : "Connect a worker provider"}</h2>
          <p>{worker.availableModels.length > 0 ? "Butler has not delegated work from this session." : "Connect at least one provider before Butler delegates work."}</p>
          {worker.availableModels.length === 0 ? <button className="button is-primary" type="button" onClick={onOpenProviderSettings}>Open provider settings</button> : null}
        </div>
      </section>
    );
  }
  const worker = pair.compose.worker;
  const busy = pair.worker.status === "starting" || pair.worker.status === "running";
  const effort = pair.worker.requestedReasoningEffort ?? worker.effort ?? null;
  const activeModel = workerModelForRoute(worker.availableModels, pair.worker.model, pair.worker.harness);
  const options = activeModel?.supportedReasoningEfforts ?? [];
  const route = `${workerProviderLabel(pair.worker.provider)} · ${workerModelLabel(worker.availableModels, pair.worker.model, pair.worker.harness)}`;
  const workerSummary = `${pair.worker.status} · ${route}`;
  const hasAlternativeModel = worker.availableModels.some((model) => !isSameWorkerRoute(model, pair.worker?.model, pair.worker?.harness));
  const switchDisabled = busy || handoffPending || !hasAlternativeModel;
  const switchTitle = busy
    ? "Available after the current worker turn finishes."
    : handoffPending
      ? "Worker switch in progress."
      : !hasAlternativeModel
        ? "No other Worker model is available."
        : "Start a new worker with a handoff.";
  const previewIndex = previewMedia
    ? previewGallery.findIndex((entry) => entry.url === previewMedia.url && entry.kind === previewMedia.kind)
    : -1;
  const canCyclePreview = previewGallery.length > 1 && previewIndex >= 0;

  function cyclePreview(offset: number): void {
    if (!canCyclePreview) return;
    const nextIndex = (previewIndex + offset + previewGallery.length) % previewGallery.length;
    setPreviewMedia(previewGallery[nextIndex] ?? null);
  }

  return (
    <section className="pane" aria-label="Worker lane">
      <div className="pane-head worker-pane-head">
        <div className="pane-head-info">
          <h2>Worker <span className="worker-id-label">· {shortId(pair.worker.threadId)}</span></h2>
          <span className="pane-sub worker-summary" title={workerSummary}>{workerSummary}</span>
        </div>
        <div className="worker-controls" aria-label="Worker settings">
          <span className="worker-route-compact" title={route}>{workerModelLabel(worker.availableModels, pair.worker.model, pair.worker.harness)}</span>
          {options.length > 0 ? (
            <BudgetSegmented
              label="Thinking"
              value={effort}
              options={options}
              disabled={busy}
              onChange={onWorkerEffortChange}
              className="worker-budget"
            />
          ) : null}
          {worker.availableModels.length > 0 ? (
            <button className="button worker-switch-button" type="button" disabled={switchDisabled} title={switchTitle} aria-label="Switch worker" onClick={() => setSwitchOpen(true)}>
              <StatusIcon kind="model" />
              <span className="worker-switch-label">Switch worker…</span>
            </button>
          ) : <button className="button" type="button" onClick={onOpenProviderSettings}>Reconnect provider</button>}
          <WorkerSessionControlsButton pairId={pair.id} disabled={handoffPending} />
        </div>
      </div>
      <WorkerTimelineView loading={loading} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={onLoadOlder} timeline={timeline} proofRecords={proofRecords} resetKey={pair.worker?.threadId ?? pair.id} onOpenArtifact={onOpenArtifact} onPreviewImage={(media, gallery = [media]) => {
        setPreviewError(null);
        setPreviewGallery(gallery.length > 0 ? gallery : [media]);
        setPreviewMedia(media);
      }} />
      {previewError ? <div className="error worker-proof-preview-error" role="alert">{previewError}</div> : null}
      {previewMedia ? (
        <ImagePreviewModal
          media={previewMedia}
          attachTargetLabel="Butler composer"
          uploadContext={{ sessionId: pair.id, origin: "image-annotation" }}
          onAttached={onAttachAnnotatedProof}
          onPrevious={canCyclePreview ? () => cyclePreview(-1) : null}
          onNext={canCyclePreview ? () => cyclePreview(1) : null}
          positionLabel={canCyclePreview ? `${previewIndex + 1} of ${previewGallery.length}` : null}
          onClose={() => {
            setPreviewMedia(null);
            setPreviewGallery([]);
          }}
          showErrorToast={(error) => setPreviewError(error instanceof Error ? error.message : String(error))}
        />
      ) : null}
      <WorkerSwitchDialog
        open={switchOpen}
        activeWorker={pair.worker}
        models={worker.availableModels}
        initialModel={worker.model}
        initialHarness={worker.harness}
        initialEffort={worker.effort}
        pending={handoffPending}
        error={handoffError}
        onClose={() => setSwitchOpen(false)}
        onConfirm={(model, harness, nextEffort) => {
          void onHandoff(model, harness, nextEffort).then((switched) => {
            if (switched) setSwitchOpen(false);
          });
        }}
      />
    </section>
  );
}
function WorkerTimelineView({
  loading,
  hasMore,
  loadingOlder,
  onLoadOlder,
  timeline,
  proofRecords,
  resetKey,
  onOpenArtifact,
  onPreviewImage
}: {
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void;
  timeline: WorkerTimeline;
  proofRecords: WorkerProofRecord[];
  resetKey: string;
  onOpenArtifact: (entry: WorkerJobOutputManifestEntry) => void;
  onPreviewImage: OpenProofPreview;
}) {
  const { turns, report, reports, payload, outputManifest, checklist, fallback } = timeline;
  const visibleProofRecords = useMemo(
    () => proofsForLoadedWorkerWindow(turns, proofRecords, hasMore, reports),
    [hasMore, proofRecords, reports, turns]
  );
  const proofsByTurnId = useMemo(() => groupProofsByTurn(turns, visibleProofRecords, reports), [reports, turns, visibleProofRecords]);
  const reportProofs = useMemo(() => proofsForFinalReport(report, visibleProofRecords, reports, turns), [report, reports, turns, visibleProofRecords]);
  const reportProofIds = useMemo(() => new Set(reportProofs.map((proof) => proof.id)), [reportProofs]);
  const anchoredProofIds = useMemo(() => new Set([...proofsByTurnId.values()].flat().map((proof) => proof.id)), [proofsByTurnId]);
  const unanchoredProofs = useMemo(() => visibleProofRecords.filter((proof) => !anchoredProofIds.has(proof.id)), [anchoredProofIds, visibleProofRecords]);
  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.items.at(-1);
  const outputStateKey = outputManifest?.entries
    .map((entry) => `${entry.id}:${entry.available}:${entry.integrity}:${entry.status ?? ""}:${entry.currentAttempt}`)
    .join("|") ?? "";
  const bottomKey = `${lastTurn?.id ?? ""}:${lastItem?.id ?? ""}:${lastItem?.at ?? 0}:${report?.updatedAt ?? 0}:${outputStateKey}:${fallback.at(-1)?.id ?? ""}`;
  const prependKey = turns[0]?.id ?? null;
  const { ref, onScroll, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({
    bottomKey,
    prependKey,
    resetKey
  });

  if (loading && turns.length === 0 && !report && !outputManifest && fallback.length === 0) {
    return (
      <div className="transcript" ref={ref} onScroll={onScroll}>
        <div className="empty-state is-inline">
          <p>Loading worker activity…</p>
        </div>
        <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
      </div>
    );
  }

  if (turns.length === 0 && !report && !outputManifest && fallback.length === 0) {
    return (
      <div className="transcript" ref={ref} onScroll={onScroll}>
        <div className="empty-state is-inline">
          <p>Waiting for worker activity…</p>
        </div>
        <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
      </div>
    );
  }

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="worker-timeline">
        {hasMore && onLoadOlder ? (
          <div className="worker-history-more">
            <button className="button is-ghost" type="button" disabled={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? "Loading earlier activity…" : "Load earlier activity"}
            </button>
          </div>
        ) : null}
        {turns.map((turn, index) => (
          <WorkerTurnView
            key={turn.id}
            turn={turn}
            index={index}
            payload={payload}
            checklist={checklist}
            proofs={(proofsByTurnId.get(turn.id) ?? []).filter((proof) => !reportProofIds.has(proof.id))}
            onPreviewImage={onPreviewImage}
          />
        ))}
        {report ? (
          <section className="worker-report" aria-label="Latest worker report">
            <WorkerMessageRow item={reportToWorkerItem(report)} />
            <WorkerProofBundleList proofs={reportProofs} onPreviewImage={onPreviewImage} />
          </section>
        ) : null}
        {turns.length === 0 && !report ? <WorkerProofBundleList proofs={unanchoredProofs} onPreviewImage={onPreviewImage} /> : null}
        {turns.length === 0 && !report
          ? fallback.map((row) => <FallbackRow key={row.id} row={row} />)
          : null}
      </div>
      {outputManifest ? <WorkerOutputPinnedBar manifest={outputManifest} onOpenArtifact={onOpenArtifact} /> : null}
      <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
    </div>
  );
}
function proofTimestamp(proof: WorkerProofRecord): number {
  return proof.verification.checkedAt || proof.updatedAt || proof.createdAt || 0;
}
export function proofsForLoadedWorkerWindow(
  turns: WorkerTurnGroup[],
  proofs: WorkerProofRecord[],
  hasMore: boolean,
  reports: WorkerReport[] = []
): WorkerProofRecord[] {
  if (!hasMore || turns.length === 0) return proofs;
  const firstLoadedTurnAt = turns.reduce((earliest, turn) => Math.min(earliest, turn.startedAt), Number.POSITIVE_INFINITY);
  const loadedTurnIds = new Set(turns.map((turn) => turn.id));
  const references = new Set<string>();
  for (const report of reports) {
    if (!report.turnId || !loadedTurnIds.has(report.turnId)) continue;
    for (const reference of proofReferenceIds(report)) references.add(reference);
  }
  return proofs.filter((proof) =>
    proofTimestamp(proof) >= firstLoadedTurnAt || proofMatchesReference(proof, references)
  );
}
function proofReferenceIds(report: WorkerReport): Set<string> {
  const ids = new Set<string>();
  for (const evidence of report.evidence ?? []) {
    if (evidence.proofRunId) ids.add(evidence.proofRunId);
    if (evidence.artifactId) ids.add(evidence.artifactId);
  }
  for (const claim of report.claims?.claims ?? []) {
    if (claim.proofId) ids.add(claim.proofId);
  }
  return ids;
}
function proofMatchesReference(proof: WorkerProofRecord, referenceIds: Set<string>): boolean {
  return referenceIds.has(proof.id) || referenceIds.has(proof.verification.runId);
}
export function proofsForFinalReport(
  report: WorkerReport | null,
  proofs: WorkerProofRecord[],
  reports: WorkerReport[] = [],
  turns: WorkerTurnGroup[] = []
): WorkerProofRecord[] {
  if (!report || proofs.length === 0) return [];
  const referenceIds = proofReferenceIds(report);
  const exact = proofs
    .filter((proof) => proofMatchesReference(proof, referenceIds))
    .sort((left, right) => proofTimestamp(right) - proofTimestamp(left));

  const previousReportAt = reports
    .filter((entry) => entry !== report && entry.updatedAt < report.updatedAt)
    .reduce((latest, entry) => Math.max(latest, entry.updatedAt), Number.NEGATIVE_INFINITY);
  const orderedTurns = [...turns].sort((left, right) => left.startedAt - right.startedAt);
  const reportTurnIndex = orderedTurns.findIndex((turn) => turn.id === report.turnId);
  const nextTurnAt = reportTurnIndex >= 0 ? orderedTurns[reportTurnIndex + 1]?.startedAt ?? null : null;
  const upperBound = nextTurnAt === null ? report.updatedAt + 10_000 : Math.min(report.updatedAt + 10_000, nextTurnAt);
  const newestFirst = proofs
    .filter((proof) => {
      const at = proofTimestamp(proof);
      return at > previousReportAt && at < upperBound;
    })
    .sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
  if (exact.length > 0) {
    const grouped = new Map<string, WorkerProofRecord>();
    for (const proof of [...exact, ...newestFirst]) grouped.set(proof.id, proof);
    return [...grouped.values()].sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
  }
  if (newestFirst.length === 0) return [];
  const visualProofs = newestFirst
    .filter((proof) => proof.verification.artifacts.some(isPreviewableProofMedia));
  return visualProofs.length > 0 ? visualProofs : [newestFirst[0]!];
}
export function groupProofsByTurn(
  turns: WorkerTurnGroup[],
  proofs: WorkerProofRecord[],
  reports: WorkerReport[] = []
): Map<string, WorkerProofRecord[]> {
  const orderedTurns = [...turns].sort((left, right) => left.startedAt - right.startedAt);
  const grouped = new Map<string, WorkerProofRecord[]>();
  if (orderedTurns.length === 0) return grouped;

  const proofIdsAssignedByReport = new Set<string>();
  const completedTurns = orderedTurns.filter((turn) => turn.completedAt !== null);
  const completedTurnIds = new Set(completedTurns.map((turn) => turn.id));
  for (const report of reports) {
    if (!report.turnId || !completedTurnIds.has(report.turnId)) continue;
    const referenceIds = proofReferenceIds(report);
    if (referenceIds.size === 0) continue;
    const exactProofs = proofs
      .filter((proof) => proofMatchesReference(proof, referenceIds))
      .sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
    if (exactProofs.length === 0) continue;
    const entries = grouped.get(report.turnId) ?? [];
    for (const proof of exactProofs) {
      if (entries.some((entry) => entry.id === proof.id)) continue;
      entries.push(proof);
      proofIdsAssignedByReport.add(proof.id);
    }
    entries.sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
    grouped.set(report.turnId, entries);
  }
  const orderedReports = reports
    .filter((report): report is WorkerReport & { turnId: string } => Boolean(report.turnId && completedTurnIds.has(report.turnId)))
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const [index, report] of orderedReports.entries()) {
    if (grouped.has(report.turnId)) continue;
    const previousReportAt = orderedReports[index - 1]?.updatedAt ?? Number.NEGATIVE_INFINITY;
    const reportTurnIndex = orderedTurns.findIndex((turn) => turn.id === report.turnId);
    const nextTurnAt = reportTurnIndex >= 0 ? orderedTurns[reportTurnIndex + 1]?.startedAt ?? null : null;
    const upperBound = nextTurnAt === null ? report.updatedAt + 10_000 : Math.min(report.updatedAt + 10_000, nextTurnAt);
    const visualCandidates = proofs
      .filter((proof) => {
        const at = proofTimestamp(proof);
        return !proofIdsAssignedByReport.has(proof.id)
          && at > previousReportAt
          && at < upperBound
          && proof.verification.artifacts.some(isPreviewableProofMedia);
      })
      .sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
    if (visualCandidates.length === 0) continue;
    grouped.set(report.turnId, visualCandidates);
    for (const proof of visualCandidates) proofIdsAssignedByReport.add(proof.id);
  }

  for (const proof of proofs) {
    if (proofIdsAssignedByReport.has(proof.id)) continue;
    const proofAt = proofTimestamp(proof);
    const target =
      [...orderedTurns].reverse().find((turn) => proofAt >= turn.startedAt) ??
      orderedTurns[0];
    const entries = grouped.get(target.id) ?? [];
    entries.push(proof);
    entries.sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
    grouped.set(target.id, entries);
  }

  return grouped;
}
