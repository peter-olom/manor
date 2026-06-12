import type { ManorRestartRun } from "./types";

export const MANOR_RESTART_TRACKED_RUN_KEY = "manor.restart.trackedRunId";
export const MANOR_RESTART_DISMISSED_RUN_KEY = "manor.restart.dismissedRunId";
export const MANOR_RESTART_POLL_MS = 2000;

export function findFailedRestartStep(run: ManorRestartRun) {
  return [...run.steps].reverse().find((step) => step.status === "failed") ?? null;
}

export function formatRestartNoticeTitle(run: ManorRestartRun): string {
  if (run.status === "completed") {
    return "Manor restart succeeded";
  }
  if (run.status === "failed") {
    return "Manor restart failed";
  }
  return "Manor restart running";
}

export function formatRestartNoticeDetail(run: ManorRestartRun): string {
  if (run.status === "completed") {
    return "Manor is back online.";
  }
  if (run.status === "running") {
    return "Waiting for the host controller to finish.";
  }

  const failedStep = findFailedRestartStep(run);
  const stderrLine = failedStep?.stderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return run.error ?? stderrLine ?? "No error detail was reported.";
}

export function formatRestartNoticeTarget(run: ManorRestartRun): string {
  const target = run.gitRef ?? run.imageTag ?? run.target;
  return `${run.mode} · ${target}`;
}

export function selectRestartStatusRun(status: {
  active: ManorRestartRun | null;
  latestRun: ManorRestartRun | null;
}, expectedRunId: string): ManorRestartRun | null {
  return [status.active, status.latestRun].find((run): run is ManorRestartRun => run?.id === expectedRunId) ?? null;
}

export function ManorRestartNotice({
  run,
  onDismiss
}: {
  run: ManorRestartRun;
  onDismiss: (run: ManorRestartRun) => void;
}) {
  const failedStep = findFailedRestartStep(run);

  return (
    <div className="modal-backdrop manor-restart-backdrop">
      <div
        className={`modal-card manor-restart-dialog manor-restart-result is-${run.status}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manor-restart-result-title"
        aria-describedby="manor-restart-result-copy"
      >
        <div className="modal-head manor-restart-head">
          <div>
            <p className="manor-restart-kicker">Live Manor stack</p>
            <h2 id="manor-restart-result-title">{formatRestartNoticeTitle(run)}</h2>
          </div>
        </div>
        <p className="modal-copy manor-restart-copy" id="manor-restart-result-copy">
          {formatRestartNoticeDetail(run)}
        </p>
        <dl className="manor-restart-details">
          <div>
            <dt>Target</dt>
            <dd>{formatRestartNoticeTarget(run)}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd>{run.id}</dd>
          </div>
          {failedStep ? (
            <div>
              <dt>Failed step</dt>
              <dd>{failedStep.label}</dd>
            </div>
          ) : null}
        </dl>
        {run.status === "failed" && failedStep?.stderrTail ? (
          <pre className="manor-restart-error">{failedStep.stderrTail}</pre>
        ) : null}
        <div className="modal-actions">
          <button
            className="panel-action"
            onClick={() => onDismiss(run)}
            disabled={run.status === "running"}
          >
            {run.status === "running" ? "Waiting..." : "Dismiss"}
          </button>
        </div>
      </div>
    </div>
  );
}
