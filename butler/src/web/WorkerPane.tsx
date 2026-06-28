import { memo, useMemo, useState } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import {
  ChevronDownIcon,
  ChevronRightIcon
} from "./icons";

import type { PairDetail } from "../shared/pairing";
import { DEFAULT_THINKING_LEVELS } from "../shared/pairing";

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
  updatedAt: number;
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
  checklist: Array<{ id: string; text: string; status: string; note: string | null }>;
  proof: string[];
  constraints: string[];
  notes: string[];
  nodes: Array<{ id: string; kind: string; parentId: string | null; summary: string; instruction: string; createdAt: number }>;
  delivery: {
    threadId: string;
    turnId: string | null;
    messageId: string | null;
  };
  report: WorkerReport | null;
};

export type WorkerTimeline = {
  turns: WorkerTurnGroup[];
  report: WorkerReport | null;
  payload: WorkerJobPayload | null;
  fallback: WorkerItem[];
};

type WorkerPaneProps = {
  pair: PairDetail;
  timeline: WorkerTimeline;
  onCodexEffortChange: (effort: string) => void;
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
  if (isMessage(type)) return type.startsWith("agent") || type === "assistant_message" ? "Codex" : "Butler";
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

function messageSpeaker(item: WorkerItem): "Butler" | "Codex" {
  return isButlerMessage(item) ? "Butler" : "Codex";
}

function messageClass(item: WorkerItem): string {
  return isButlerMessage(item) ? "is-butler" : "is-codex";
}

function payloadLabel(tag: string): string {
  if (tag === "checklist") return "Checklist";
  if (tag === "proof") return "Proof";
  if (tag === "constraints") return "Constraints";
  if (tag === "notes") return "Notes";
  if (tag === "report") return "Report";
  return tag;
}

function payloadSectionText(payload: WorkerJobPayload, tag: string): string {
  if (tag === "checklist") {
    return payload.checklist.length
      ? payload.checklist.map((item, index) => `${index + 1}. ${item.text}${item.note ? `\n   ${item.note}` : ""}`).join("\n")
      : "No checklist items.";
  }
  if (tag === "proof") return payload.proof.length ? payload.proof.map((item) => `- ${item}`).join("\n") : "No proof requested.";
  if (tag === "constraints") return payload.constraints.length ? payload.constraints.map((item) => `- ${item}`).join("\n") : "No constraints.";
  if (tag === "notes") return payload.notes.length ? payload.notes.map((item) => `- ${item}`).join("\n") : "No notes.";
  if (tag === "report" && payload.report) return `${payload.report.status}: ${payload.report.summary}${payload.report.details ? `\n\n${payload.report.details}` : ""}`;
  return payload.display.summary;
}

const WorkerPayloadDetails = memo(function WorkerPayloadDetails({ payload }: { payload: WorkerJobPayload }) {
  const tags = payload.display.tags.length > 0 ? payload.display.tags : ["checklist", "proof", "constraints", "notes"];
  const [activeTag, setActiveTag] = useState(tags[0] ?? "checklist");
  return (
    <details className="worker-payload">
      <summary>
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
              aria-selected={activeTag === tag}
              className={activeTag === tag ? "is-selected" : ""}
              onClick={() => setActiveTag(tag)}
            >
              {payloadLabel(tag)}
            </button>
          ))}
        </div>
        <Markdown className="worker-payload-body" text={payloadSectionText(payload, activeTag)} />
      </div>
    </details>
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
};

const WorkerMessageRow = memo(function WorkerMessageRow({ item, streaming, payload }: WorkerMessageRowProps) {
  const showPayload = isButlerMessage(item) && payload;
  return (
    <article className={`worker-message ${messageClass(item)} ${streaming ? "is-streaming" : ""}`}>
      <header className="worker-message-head">
        <span className="worker-message-label">{messageSpeaker(item)}</span>
        <time className="worker-message-time">{formatTime(item.at)}</time>
      </header>
      <Markdown className="worker-message-body" text={item.text} />
      {showPayload ? <WorkerPayloadDetails payload={payload} /> : null}
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
};

const WorkerActiveTurn = memo(function WorkerActiveTurn({ turn, index, payload }: WorkerActiveTurnProps) {
  const sorted = useMemo(() => [...turn.items].sort((a, b) => a.at - b.at), [turn.items]);
  return (
    <section className="worker-turn is-active" aria-label={`Worker turn ${index + 1} in progress`}>
      <header className="worker-turn-head">
        <span className="worker-turn-dot" aria-hidden="true" />
        <span className="worker-turn-title">Codex turn {index + 1}</span>
        <span className="worker-turn-status">in progress</span>
        <time className="worker-turn-time">{formatTime(turn.startedAt)}</time>
      </header>
      <div className="worker-turn-items">
        {sorted.map((item) =>
          isMessage(item.type) ? (
            <WorkerMessageRow key={item.id} item={item} payload={payload} streaming={item.status === "started"} />
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
};

const WorkerCompletedTurn = memo(function WorkerCompletedTurn({ turn, index, payload }: WorkerCompletedTurnProps) {
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
        <span className="worker-turn-title">Codex turn {index + 1}</span>
        <span className="worker-turn-status is-done">complete</span>
        <time className="worker-turn-time">{formatTime(turn.startedAt)}</time>
        {durationMs > 0 ? <span className="worker-turn-duration">{formatDuration(durationMs)}</span> : null}
      </header>
      {leadingMessages.map((item) => <WorkerMessageRow key={item.id} item={item} payload={payload} />)}
      {supporting.length > 0 ? (
        <details className="worker-activity" {...(defaultOpen ? { open: true } : {})}>
          <summary>
            <span>{activityLabel}</span>
          </summary>
          <WorkerActivityList items={supporting} />
        </details>
      ) : null}
      {finalItem ? <WorkerMessageRow key={finalItem.id} item={finalItem} payload={payload} /> : null}
    </section>
  );
});

const WorkerTurnView = memo(function WorkerTurnView({ turn, index, payload }: { turn: WorkerTurnGroup; index: number; payload: WorkerJobPayload | null }) {
  if (turn.completedAt === null) return <WorkerActiveTurn turn={turn} index={index} payload={payload} />;
  return <WorkerCompletedTurn turn={turn} index={index} payload={payload} />;
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

export function WorkerPane({ pair, timeline, onCodexEffortChange }: WorkerPaneProps) {
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

  const codex = pair.compose?.codex ?? { effort: null, availableEfforts: [] };
  const busy = pair.status === "worker_running";
  const effort = pair.worker.requestedReasoningEffort ?? codex.effort ?? null;
  const options = codex.availableEfforts.length > 0 ? codex.availableEfforts : [...DEFAULT_THINKING_LEVELS];

  return (
    <section className="pane" aria-label="Codex worker lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Codex · {shortId(pair.worker.threadId)}</h2>
          <span className="pane-sub">{pair.worker.status} · one worker max</span>
        </div>
        <BudgetSegmented
          label="Codex thinking"
          value={effort}
          options={options}
          disabled={busy}
          onChange={onCodexEffortChange}
          className="worker-budget"
        />
      </div>
      <WorkerTimelineView timeline={timeline} />
    </section>
  );
}

function WorkerTimelineView({ timeline }: { timeline: WorkerTimeline }) {
  const { turns, report, payload, fallback } = timeline;
  const lastTurn = turns.at(-1);
  const lastItem = lastTurn?.items.at(-1);
  const bottomKey = `${turns.length}:${lastItem?.id ?? ""}:${lastItem?.at ?? 0}:${report?.updatedAt ?? 0}:${fallback.length}`;
  const resetKey = turns.length === 0 && !report ? (fallback.at(-1)?.id ?? "") : undefined;
  const { ref, onScroll, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({
    bottomKey,
    resetKey
  });

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
            payload={payload && (payload.delivery.turnId ? payload.delivery.turnId === turn.id : index === turns.length - 1) ? payload : null}
          />
        ))}
        {report ? <WorkerMessageRow item={reportToWorkerItem(report)} /> : null}
        {turns.length === 0 && !report
          ? fallback.map((row) => <FallbackRow key={row.id} row={row} />)
          : null}
      </div>
      <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
    </div>
  );
}

export type WorkerItemExport = WorkerItem;
