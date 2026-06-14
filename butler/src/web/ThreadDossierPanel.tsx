import type { CodexThreadDetail, ReviewPanelRun, VerificationCheckKind, VerificationMatrixRow } from "./types";

type ThreadChecklist = NonNullable<CodexThreadDetail["supervisionChecklist"]>;

function formatChecklistItemStatus(status: ThreadChecklist["items"][number]["status"]): string {
  if (status === "accepted") return "Done";
  if (status === "waived") return "Waived";
  if (status === "rejected") return "Needs work";
  return "Pending";
}

function formatVerificationCheckLabel(kind: VerificationCheckKind): string {
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getChecklistMatrixRows(rows: VerificationMatrixRow[], item: ThreadChecklist["items"][number]): VerificationMatrixRow[] {
  const pointNumber = item.id.replace(/^point-/, "");
  const fallbackRowId = pointNumber ? `row-${pointNumber}` : null;
  return rows.filter((row) => row.acceptancePointId === item.id || (fallbackRowId ? row.id === fallbackRowId : false));
}

export function ThreadDossierPanel({
  checklist,
  progressLabel,
  verificationMatrix,
  reviewPanel
}: {
  checklist: ThreadChecklist;
  progressLabel: string | null;
  verificationMatrix: VerificationMatrixRow[];
  reviewPanel: ReviewPanelRun[];
}) {
  return (
    <div className="conversation-disclosure-panel thread-checklist-panel">
      <div className="thread-checklist-head">
        <div>
          <h3>Review dossier</h3>
          <p>{checklist.requestedTask}</p>
        </div>
        <span className="thread-checklist-progress">{progressLabel}</span>
      </div>
      <ol className="thread-checklist-items">
        {checklist.items.map((item) => {
          const completed = item.status === "accepted" || item.status === "waived";
          const matrixRows = getChecklistMatrixRows(verificationMatrix, item);
          const visibleEvidence = item.evidence.slice(-4);
          return (
            <li key={item.id} className={`thread-checklist-item is-${item.status}${completed ? " is-complete" : ""}`}>
              <span className="thread-checklist-marker" aria-hidden="true" />
              <div className="thread-checklist-main">
                <div className="thread-checklist-title-row">
                  <span className="thread-checklist-text">{item.text}</span>
                  <span className="thread-checklist-status">{formatChecklistItemStatus(item.status)}</span>
                </div>
                {matrixRows.length > 0 ? (
                  <div className="thread-checklist-matrix">
                    {matrixRows.map((row) => (
                      <div key={row.id} className={`thread-checklist-matrix-row is-${row.status}`}>
                        <div className="thread-checklist-checks">
                          {row.checkKinds.map((kind) => (
                            <span key={`${row.id}-${kind}`}>{formatVerificationCheckLabel(kind)}</span>
                          ))}
                        </div>
                        {row.expectedEvidence.length > 0 ? (
                          <div className="thread-checklist-expected">Evidence: {row.expectedEvidence.slice(0, 3).join("; ")}</div>
                        ) : null}
                        {[...row.artifactRefs, ...row.commandRefs].length > 0 ? (
                          <div className="thread-checklist-refs">
                            References: {[...row.artifactRefs, ...row.commandRefs].slice(0, 3).join(", ")}
                          </div>
                        ) : null}
                        {row.reviewerNote ? <div className="thread-checklist-note">Butler note: {row.reviewerNote}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {visibleEvidence.length > 0 ? (
                  <div className="thread-checklist-evidence">
                    {visibleEvidence.map((entry) => (
                      <div key={entry.id} className="thread-checklist-evidence-row">
                        <span>{entry.source === "butler_review" ? "Butler" : "Worker"}</span>
                        <p>{entry.summary}</p>
                        {entry.command ? <code>{entry.command}</code> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {item.queuedInstruction ? <div className="thread-checklist-rework">Rework: {item.queuedInstruction}</div> : null}
                {item.butlerNote ? <div className="thread-checklist-note">Butler note: {item.butlerNote}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {reviewPanel.length > 0 ? (
        <div className="thread-review-panel-summary" aria-label="Reviewer summary">
          <div className="thread-review-panel-title">Reviewers challenged</div>
          <div className="thread-review-panel-grid">
            {reviewPanel.map((entry) => (
              <div key={entry.id} className={`thread-review-panel-row is-${entry.verdict}`}>
                <span>{entry.label}</span>
                <strong>{entry.verdict === "concern" ? "concern" : entry.verdict}</strong>
                {entry.requiredFollowUp || entry.concerns[0] || entry.reviewerNote ? (
                  <p>{entry.requiredFollowUp ?? entry.concerns[0] ?? entry.reviewerNote}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
