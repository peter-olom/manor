import { useEffect, useMemo, useState } from "react";

import { postJson } from "./api";
import { WarningIcon } from "./icons";
import type { SelfImprovementQueueResponse, SelfImprovementRequestView } from "../shared/self-improvement";

export function formatSelfImprovementTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function selfImprovementStatusLabel(status: string): string {
  if (status === "discarded") return "closed";
  return status.replace(/_/g, " ");
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="improve-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function SelfImprovementQueue({
  data,
  selectedId,
  onReload,
  onOpenSession
}: {
  data: SelfImprovementQueueResponse | null;
  selectedId: string | null;
  onReload: () => Promise<void>;
  onOpenSession: (request: SelfImprovementRequestView) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");

  const selected = useMemo(
    () => data?.requests.find((request) => request.id === selectedId) ?? data?.requests[0] ?? null,
    [data?.requests, selectedId]
  );

  useEffect(() => {
    setDismissReason("");
    setCommitMessage(selected ? `Self-improvement: ${selected.trigger}` : "");
    setPrTitle(selected?.trigger ?? "");
  }, [selected?.id]);

  async function runAction(action: string, body: Record<string, unknown> = {}) {
    if (!selected) return;
    setBusyAction(action);
    setError(null);
    try {
      const payload = await postJson<{ request?: SelfImprovementRequestView }>(`/api/self-improvement/requests/${encodeURIComponent(selected.id)}/${action}`, body);
      await onReload();
      if (action === "approve" && payload?.request?.pairId) {
        await onOpenSession(payload.request);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function openSession(request: SelfImprovementRequestView) {
    if (!request.threadId && !request.pairId) return;
    setBusyAction("open");
    setError(null);
    try {
      await onOpenSession(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteRequest() {
    if (!selected) return;
    const hasActiveSession = ["approved", "running", "changes_ready", "committed", "pr_opened"].includes(selected.status);
    const warning = hasActiveSession
      ? `Delete this self-improvement request and its linked Worker history permanently? Its active session will be closed first. Source changes and commits will remain. This cannot be undone.`
      : `Delete this self-improvement request and its linked Worker history permanently? Source changes and commits will remain. This cannot be undone.`;
    if (!window.confirm(warning)) return;
    await runAction("delete");
  }

  const requests = data?.requests ?? [];
  const eligibility = data?.eligibility;
  const actionInProgress = busyAction !== null;

  return (
    <section className="improve-panel is-detail-only">
      <div className="improve-body is-detail-only">
        <article className="improve-detail">
          {!selected ? (
            <div className="improve-empty">No request selected.</div>
          ) : (
            <>
              <div className="improve-detail-head">
                <div>
                  <span className={`improve-status is-${selected.status}`}>{selfImprovementStatusLabel(selected.status)}</span>
                  <h3>{selected.trigger}</h3>
                  <p>{formatSelfImprovementTime(selected.requestedAt)}</p>
                </div>
                <div className="improve-actions">
                  {selected.threadId || selected.pairId ? <button className="button" type="button" disabled={actionInProgress} onClick={() => void openSession(selected)}>Open session</button> : null}
                  {selected.status === "pending" ? <button className="button is-primary" type="button" disabled={!eligibility?.enabled || actionInProgress} onClick={() => void runAction("approve")}>Approve</button> : null}
                  {selected.status === "approved" || selected.status === "running" || selected.status === "changes_ready" || selected.status === "committed" || selected.status === "pr_opened" ? <button className="button" type="button" disabled={actionInProgress} onClick={() => void runAction("discard")}>Close request</button> : null}
                  <button className="button is-danger" type="button" disabled={actionInProgress} onClick={() => void deleteRequest()}>{busyAction === "delete" ? "Deleting…" : "Delete"}</button>
                </div>
              </div>

              {eligibility && !eligibility.enabled && selected.status === "pending" ? (
                <div className="improve-warning">
                  <WarningIcon />
                  <span>{eligibility.reasons.join(" ")}</span>
                </div>
              ) : null}

              <dl className="improve-detail-grid">
                <DetailRow label="Symptoms" value={selected.symptoms} />
                <DetailRow label="Logs" value={selected.logs} />
                <DetailRow label="Observations" value={selected.observations} />
                <DetailRow label="Suspected cause" value={selected.suspectedCause} />
                <DetailRow label="Proposed change" value={selected.proposedChange} />
                <DetailRow label="Risk" value={selected.risk} />
                <DetailRow label="Desired outcome" value={selected.desiredOutcome} />
                <DetailRow label="Workspace" value={selected.workspaceCwd} />
                <DetailRow label="Branch" value={selected.branchName} />
                <DetailRow label="Commit" value={selected.commitSha} />
                <DetailRow label="Pull request" value={selected.pullRequestUrl} />
              </dl>

              {selected.status === "pending" ? (
                <div className="improve-form">
                  <input value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} placeholder="Dismiss reason" />
                  <button className="button" type="button" disabled={actionInProgress} onClick={() => void runAction("dismiss", { reason: dismissReason })}>Dismiss</button>
                </div>
              ) : null}

              {selected.status === "changes_ready" ? (
                <div className="improve-form">
                  <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" />
                  <button className="button is-primary" type="button" disabled={!commitMessage.trim() || actionInProgress} onClick={() => void runAction("commit", { message: commitMessage })}>Commit current checkout</button>
                </div>
              ) : null}

              {selected.status === "committed" ? (
                <div className="improve-form">
                  <input value={prTitle} onChange={(event) => setPrTitle(event.target.value)} placeholder="PR title" />
                  <button className="button is-primary" type="button" disabled={!prTitle.trim() || actionInProgress} onClick={() => void runAction("pr", { title: prTitle })}>Open draft PR</button>
                </div>
              ) : null}
            </>
          )}
          {error ? <div className="error" role="alert"><WarningIcon /><span>{error}</span></div> : null}
        </article>
      </div>
    </section>
  );
}
