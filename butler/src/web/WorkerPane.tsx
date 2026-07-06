import { memo, useMemo, useState } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { ImagePreviewModal, type PreviewMedia } from "./ImagePreviewModal";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import {
  ChevronDownIcon,
  ChevronRightIcon
} from "./icons";

import type { PairDetail } from "../shared/pairing";
import type { FileReference } from "./api";

export type WorkerItem = {
  id: string;
  type: string;
  status: string;
  text: string;
  at: number;
  taskDurationMs?: number | null;
};

export type WorkerTurnGroup = {
  id: string;
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
  checklist: WorkerChecklistItem[] | null;
  fallback: WorkerItem[];
};

type WorkerPaneProps = {
  pair: PairDetail;
  timeline: WorkerTimeline;
  loading?: boolean;
  proofRecords: WorkerProofRecord[];
  onCodexModelChange: (model: string) => void;
  onCodexEffortChange: (effort: string) => void;
  onWorkerRuntimeChange: (runtime: "auto" | "openai" | "pi-rpc") => void;
  onAttachAnnotatedProof: (payload: { attachment: FileReference; text: string }) => Promise<void>;
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
    text: `${report.summary}${report.details ? `\n\n${report.details}` : ""}`,
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

function proofStatusLabel(proof: WorkerProofRecord): string {
  const review = proof.proofReviews?.at(-1);
  if (review?.verdict) return review.verdict;
  return proof.verification.ok ? "recorded" : proof.verification.failureKind;
}

function proofArtifactLabel(artifact: WorkerProofArtifact): string {
  return artifact.label || artifact.fileName || artifact.kind;
}

const WorkerProofBundleList = memo(function WorkerProofBundleList({
  proofs,
  onPreviewImage
}: {
  proofs: WorkerProofRecord[];
  onPreviewImage: (media: PreviewMedia) => void;
}) {
  if (proofs.length === 0) return null;
  const visibleProofs = proofs.slice(0, 4);
  return (
    <section className="worker-proof-bundles" aria-label="Proof attached to conversation">
      <header className="worker-proof-head">
        <span>Proof attached</span>
        <span>{proofs.length} bundle{proofs.length === 1 ? "" : "s"}</span>
      </header>
      <div className="worker-proof-list">
        {visibleProofs.map((proof) => {
          const screenshots = proof.verification.artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.url && artifact.availability === "available").slice(0, 3);
          const artifacts = proof.verification.artifacts.filter((artifact) => artifact.availability === "available").slice(0, 5);
          const review = proof.proofReviews?.at(-1);
          return (
            <article key={proof.id} className={`worker-proof-card ${proof.verification.ok ? "is-ok" : "is-failed"}`}>
              <div className="worker-proof-card-head">
                <div>
                  <h3>{proof.previewTitle || "Proof bundle"}</h3>
                  <p>{proof.verification.runId}</p>
                </div>
                <span>{proofStatusLabel(proof)}</span>
              </div>
              {screenshots.length > 0 ? (
                <div className="worker-proof-shots">
                  {screenshots.map((artifact) => (
                    <button
                      key={`${proof.id}:${artifact.fileName}`}
                      type="button"
                      title={proofArtifactLabel(artifact)}
                      onClick={() =>
                        onPreviewImage({
                          name: artifact.fileName || artifact.label || "Proof screenshot",
                          url: artifact.url ?? "",
                          kind: "image",
                          downloadUrl: artifact.downloadUrl ?? artifact.url
                        })
                      }
                    >
                      <img src={artifact.url ?? undefined} alt={proofArtifactLabel(artifact)} />
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="worker-proof-artifacts">
                {artifacts.map((artifact) => (
                  <span key={`${proof.id}:artifact:${artifact.fileName}`}>{proofArtifactLabel(artifact)}</span>
                ))}
              </div>
              {review?.visibleState ? <p className="worker-proof-review">{review.visibleState}</p> : null}
            </article>
          );
        })}
      </div>
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
    <details className={`worker-row-compact ${statusBadgeClass(item.status)}`}>
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
};

const WorkerActiveTurn = memo(function WorkerActiveTurn({ turn, index, payload, checklist }: WorkerActiveTurnProps) {
  const sorted = useMemo(() => [...turn.items].sort((a, b) => a.at - b.at), [turn.items]);
  return (
    <section className="worker-turn is-active" aria-label={`Worker turn ${index + 1} in progress`}>
      <header className="worker-turn-head">
        <span className="worker-turn-dot" aria-hidden="true" />
        <span className="worker-turn-title">Worker turn {index + 1}</span>
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
    </section>
  );
});

type WorkerCompletedTurnProps = {
  turn: WorkerTurnGroup;
  index: number;
  payload: WorkerJobPayload | null;
  checklist: WorkerChecklistItem[] | null;
  proofs: WorkerProofRecord[];
  onPreviewImage: (media: PreviewMedia) => void;
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
  const defaultOpen = !finalItem;

  return (
    <section className="worker-turn is-complete" aria-label={`Worker turn ${index + 1} complete`}>
      <header className="worker-turn-head">
        <span className="worker-turn-title">Worker turn {index + 1}</span>
        <span className="worker-turn-status is-done">complete</span>
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
      {finalItem ? <WorkerProofBundleList proofs={proofs} onPreviewImage={onPreviewImage} /> : null}
    </section>
  );
});

const WorkerTurnView = memo(function WorkerTurnView({
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
  onPreviewImage: (media: PreviewMedia) => void;
}) {
  if (turn.completedAt === null) return <WorkerActiveTurn turn={turn} index={index} payload={payload} checklist={checklist} />;
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

export function WorkerPane({ pair, timeline, loading = false, proofRecords, onCodexModelChange, onCodexEffortChange, onWorkerRuntimeChange, onAttachAnnotatedProof }: WorkerPaneProps) {
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  if (!pair.worker) {
    const worker = pair.compose?.worker ?? pair.compose?.codex ?? { model: null, effort: null, availableModels: [], availableEfforts: [] };
    const options = worker.availableEfforts;
    const model = worker.model ?? worker.availableModels[0]?.id ?? null;
    const effort = worker.effort ?? null;
    const runtime = pair.workerRuntime ?? ("runtime" in worker && worker.runtime ? worker.runtime : "auto");
    return (
      <section className="pane" aria-label="Worker lane">
        <div className="pane-head">
          <div className="pane-head-info">
            <h2>Worker</h2>
            <span className="pane-sub">No worker attached</span>
          </div>
          <div className="worker-controls" aria-label="Worker settings">
            <label className="worker-runtime">
              <span className="sr-only">Worker runtime</span>
              <select
                value={runtime}
                aria-label="Worker runtime"
                title="Worker runtime"
                onChange={(event) => onWorkerRuntimeChange(event.target.value as "auto" | "openai" | "pi-rpc")}
              >
                <option value="auto">Auto</option>
                <option value="openai">OpenAI Codex</option>
                <option value="pi-rpc">Pi RPC</option>
              </select>
            </label>
            <ModelPicker
              label="Model"
              value={model}
              options={worker.availableModels}
              compact
              anchor="below"
              className="worker-model"
              onChange={onCodexModelChange}
            />
            {options.length > 0 ? (
              <BudgetSegmented
                label="Thinking"
                value={effort}
                options={options}
                onChange={onCodexEffortChange}
                className="worker-budget"
              />
            ) : null}
          </div>
        </div>
        <div className="empty-state">
          <h2>No worker attached</h2>
          <p>Butler has not delegated work from this session.</p>
        </div>
      </section>
    );
  }

  const worker = pair.compose?.worker ?? pair.compose?.codex ?? { model: null, effort: null, availableModels: [], availableEfforts: [] };
  const busy = pair.status === "worker_running";
  const effort = pair.worker.requestedReasoningEffort ?? worker.effort ?? null;
  const options = worker.availableEfforts;
  const model = worker.model ?? worker.availableModels[0]?.id ?? null;
  const runtime = pair.workerRuntime ?? ("runtime" in worker && worker.runtime ? worker.runtime : "auto");

  return (
    <section className="pane" aria-label="Worker lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Worker · {shortId(pair.worker.threadId)}</h2>
          <span className="pane-sub">{pair.worker.status} · one worker max</span>
        </div>
        <div className="worker-controls" aria-label="Worker settings">
          <ModelPicker
            label="Model"
            value={model}
            options={worker.availableModels}
            disabled={busy}
            compact
            anchor="below"
            className="worker-model"
            onChange={onCodexModelChange}
          />
          {options.length > 0 ? (
            <BudgetSegmented
              label="Thinking"
              value={effort}
              options={options}
              disabled={busy}
              onChange={onCodexEffortChange}
              className="worker-budget"
            />
          ) : null}
          <label className={`worker-runtime ${busy ? "is-disabled" : ""}`.trim()}>
            <span className="sr-only">Worker runtime</span>
            <select
              value={runtime}
              aria-label="Worker runtime"
              title="Worker runtime"
              disabled={busy}
              onChange={(event) => onWorkerRuntimeChange(event.target.value as "auto" | "openai" | "pi-rpc")}
            >
              <option value="auto">Auto</option>
              <option value="openai">OpenAI Codex</option>
              <option value="pi-rpc">Pi RPC</option>
            </select>
          </label>
        </div>
      </div>
      <WorkerTimelineView loading={loading} timeline={timeline} proofRecords={proofRecords} onPreviewImage={(media) => {
        setPreviewError(null);
        setPreviewMedia(media);
      }} />
      {previewError ? <div className="error worker-proof-preview-error" role="alert">{previewError}</div> : null}
      {previewMedia ? (
        <ImagePreviewModal
          media={previewMedia}
          attachTargetLabel="Butler composer"
          onAttached={onAttachAnnotatedProof}
          onClose={() => setPreviewMedia(null)}
          showErrorToast={(error) => setPreviewError(error instanceof Error ? error.message : String(error))}
        />
      ) : null}
    </section>
  );
}

function WorkerTimelineView({
  loading,
  timeline,
  proofRecords,
  onPreviewImage
}: {
  loading: boolean;
  timeline: WorkerTimeline;
  proofRecords: WorkerProofRecord[];
  onPreviewImage: (media: PreviewMedia) => void;
}) {
  const { turns, report, reports, payload, checklist, fallback } = timeline;
  const proofsByTurnId = useMemo(() => groupProofsByTurn(turns, proofRecords, reports), [proofRecords, reports, turns]);
  const anchoredProofIds = useMemo(() => new Set([...proofsByTurnId.values()].flat().map((proof) => proof.id)), [proofsByTurnId]);
  const unanchoredProofs = useMemo(() => proofRecords.filter((proof) => !anchoredProofIds.has(proof.id)), [anchoredProofIds, proofRecords]);
  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.items.at(-1);
  const bottomKey = `${turns.length}:${lastItem?.id ?? ""}:${lastItem?.at ?? 0}:${report?.updatedAt ?? 0}:${fallback.length}`;
  const resetKey = turns.length === 0 && !report ? (fallback.at(-1)?.id ?? "") : undefined;
  const { ref, onScroll, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({
    bottomKey,
    resetKey
  });

  if (loading && turns.length === 0 && !report && fallback.length === 0) {
    return (
      <div className="transcript" ref={ref} onScroll={onScroll}>
        <div className="empty-state is-inline">
          <p>Loading worker activity…</p>
        </div>
        <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
      </div>
    );
  }

  if (turns.length === 0 && !report && fallback.length === 0) {
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
        {turns.map((turn, index) => (
          <WorkerTurnView
            key={turn.id}
            turn={turn}
            index={index}
            payload={payload}
            checklist={checklist}
            proofs={proofsByTurnId.get(turn.id) ?? []}
            onPreviewImage={onPreviewImage}
          />
        ))}
        {report ? <WorkerMessageRow item={reportToWorkerItem(report)} /> : null}
        {turns.length === 0 ? <WorkerProofBundleList proofs={unanchoredProofs} onPreviewImage={onPreviewImage} /> : null}
        {turns.length === 0 && !report
          ? fallback.map((row) => <FallbackRow key={row.id} row={row} />)
          : null}
      </div>
      <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
    </div>
  );
}

function proofTimestamp(proof: WorkerProofRecord): number {
  return proof.verification.checkedAt || proof.updatedAt || proof.createdAt || 0;
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

export function groupProofsByTurn(
  turns: WorkerTurnGroup[],
  proofs: WorkerProofRecord[],
  reports: WorkerReport[] = []
): Map<string, WorkerProofRecord[]> {
  const completedTurns = turns
    .filter((turn) => turn.completedAt !== null)
    .sort((left, right) => left.startedAt - right.startedAt);
  const grouped = new Map<string, WorkerProofRecord[]>();
  if (completedTurns.length === 0) return grouped;

  const proofIdsAssignedByReport = new Set<string>();
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

  for (const proof of proofs) {
    if (proofIdsAssignedByReport.has(proof.id)) continue;
    const proofAt = proofTimestamp(proof);
    const target =
      [...completedTurns].reverse().find((turn) => proofAt >= turn.startedAt) ??
      completedTurns[0];
    const entries = grouped.get(target.id) ?? [];
    entries.push(proof);
    entries.sort((left, right) => proofTimestamp(right) - proofTimestamp(left));
    grouped.set(target.id, entries);
  }

  return grouped;
}
