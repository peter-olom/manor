import { memo } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { useVirtualWindow } from "./useVirtualWindow";
import { JumpToLatest } from "./JumpToLatest";

import type { PairDetail, PairMessage, PairTraceItem } from "../shared/pairing";

const WORKER_ROW = 132;

type WorkerItem = {
  id: string;
  type: string;
  status: string;
  text: string;
  at: number;
};

type WorkerPaneProps = {
  pair: PairDetail;
  rows: WorkerItem[];
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

type WorkerRowProps = {
  row: WorkerItem;
};

const WorkerRow = memo(function WorkerRow({ row }: WorkerRowProps) {
  return (
    <article className={`worker-item ${row.type === "worker_report" ? "is-report" : ""}`}>
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

export function WorkerPane({ pair, rows, onCodexEffortChange }: WorkerPaneProps) {
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
  const options = codex.availableEfforts.length > 0 ? codex.availableEfforts : ["low", "medium", "high", "xhigh"];

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
      <WorkerList rows={rows} />
    </section>
  );
}

function WorkerList({ rows }: { rows: WorkerItem[] }) {
  const virtual = useVirtualWindow({ count: rows.length, rowHeight: WORKER_ROW, overscan: 6 });
  const visible = rows.slice(virtual.start, virtual.end);
  const lastRowId = rows.at(-1)?.id ?? null;
  const lastRowAt = rows.at(-1)?.at ?? 0;
  const { ref, onScroll, isPinned, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({
    bottomKey: `${lastRowId}:${rows.length}:${lastRowAt}`,
    resetKey: rows.length === 0 ? lastRowId : undefined
  });
  return (
    <div className="transcript" ref={ref} onScroll={onScroll} data-virtualized-count={rows.length}>
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div className="transcript-stack" style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
          {visible.map((row) => (
            <WorkerRow key={row.id} row={row} />
          ))}
        </div>
      </div>
      <JumpToLatest count={unreadCount} onClick={() => scrollToBottom("smooth")} />
    </div>
  );
}

export type WorkerItemExport = WorkerItem;
export type WorkerPaneMessage = PairMessage;
export type WorkerPaneTrace = PairTraceItem;
