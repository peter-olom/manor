import { memo, useState } from "react";
import { Markdown } from "./Markdown";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";
import type { ReviewRecord, ReviewFinding } from "../server/orchestration-types";

type ReviewState = "queued" | "running" | "accepted" | "rejected";

function stateLabel(state: ReviewState): string {
  return state === "accepted" ? "Accepted" : state === "rejected" ? "Rejected" : state === "running" ? "Reviewing" : "Queued";
}

function stateClass(state: ReviewState): string {
  return state === "accepted" ? "is-ok" : state === "rejected" ? "is-failed" : "is-unclear";
}

function findingSeverityClass(severity: string): string {
  return severity === "critical" || severity === "high" ? "is-critical" : severity === "medium" ? "is-medium" : "is-low";
}

const ReviewFindingItem = memo(function ReviewFindingItem({ finding }: { finding: ReviewFinding }) {
  return (
    <li className={`butler-review-finding ${finding.blocking ? "is-blocking" : ""} ${finding.waived ? "is-waived" : ""}`}>
      <span className={`butler-review-finding-severity ${findingSeverityClass(finding.severity)}`}>{finding.severity}</span>
      <span className="butler-review-finding-summary">{finding.summary}</span>
      {finding.blocking ? <span className="butler-review-finding-blocking">Blocking</span> : null}
      {finding.waived ? <span className="butler-review-finding-waived">Waived</span> : null}
    </li>
  );
});

const ReviewRecordCard = memo(function ReviewRecordCard({ record, defaultOpen = false }: { record: ReviewRecord; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const findings = record.findings;
  const blockingCount = findings.filter((f) => f.blocking && !f.waived).length;
  return (
    <article className={`butler-review-card is-${record.state}`}>
      <button type="button" className="butler-review-card-toggle" onClick={() => setOpen(!open)}>
        <span className="butler-review-card-state">{stateLabel(record.state)}</span>
        <span className="butler-review-card-meta">
          {findings.length} finding{findings.length === 1 ? "" : "s"}
          {blockingCount > 0 ? ` | ${blockingCount} blocking` : ""}
          {record.reviewedAt ? ` | ${new Date(record.reviewedAt).toLocaleString()}` : ""}
        </span>
        <span className="butler-review-card-chevron">{open ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
      </button>
      {open ? (
        <div className="butler-review-card-body">
          {findings.length > 0 ? (
            <ol className="butler-review-findings">
              {findings.map((f) => <ReviewFindingItem key={f.id} finding={f} />)}
            </ol>
          ) : <p className="butler-review-no-findings">No findings.</p>}
          {record.state === "rejected" && record.workerInstruction ? (
            <div className="butler-review-instruction">
              <span>Rework: </span>
              <Markdown text={record.workerInstruction} />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

export const ButlerReviewVerdictPanel = memo(function ButlerReviewVerdictPanel({ records }: { records: ReviewRecord[] }) {
  if (!records || !Array.isArray(records) || records.length === 0) return null;
  const sorted = [...records].sort((a, b) => b.reportUpdatedAt - a.reportUpdatedAt);
  const latest = sorted[0]!;
  const history = sorted.slice(1);
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="butler-review-verdict" aria-label="Review verdict">
      <button type="button" className={`butler-review-verdict-toggle is-${latest.state}`} onClick={() => setExpanded(!expanded)}>
        <span className="butler-review-card-state">{stateLabel(latest.state)}</span>
        <span className="butler-review-card-meta">
          {latest.findings.length} finding{latest.findings.length === 1 ? "" : "s"}
          {history.length > 0 ? ` | ${history.length} earlier` : ""}
        </span>
        <span className="butler-review-card-chevron">{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
      </button>
      {expanded ? (
        <div className="butler-review-verdict-body">
          <ReviewRecordCard record={latest} />
          {history.length > 0 ? (
            <div className="butler-review-history">
              <div className="butler-review-history-label">Earlier reviews ({history.length})</div>
              {history.map((r) => <ReviewRecordCard key={r.id} record={r} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});