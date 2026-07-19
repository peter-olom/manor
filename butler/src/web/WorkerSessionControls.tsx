import { useEffect, useRef, useState } from "react";

import { getJson, postJson } from "./api";
import { SessionControlsIcon } from "./icons";
import type { ModelUsageCost, ModelUsageRow } from "../shared/model-usage";
import type { WorkerCompactionOperation, WorkerSessionControlAction, WorkerSessionControls } from "../shared/worker-session-controls";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatCellCost(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: value >= 1 ? 2 : 4 }).format(value);
}

function providerLabel(provider: string): string {
  return ({
    "ollama-cloud": "Ollama Cloud",
    "ollama-local": "Ollama Local",
    "opencode-go": "OpenCode Go",
    "openai-codex": "OpenAI Codex"
  } as Record<string, string>)[provider] ?? provider;
}

function formatUsageCost(cost: ModelUsageCost): string {
  if (cost.basis === "included") return "Included";
  if (cost.basis === "local") return "Local";
  if (cost.basis === "unavailable") return "Not priced";
  if (cost.basis === "partial" && cost.total === 0) return "No token price";
  return formatCost(cost.total);
}

function summaryCostLabel(cost: ModelUsageCost): string {
  if (cost.basis === "estimated") return "API estimate";
  return cost.basis === "partial" && cost.total > 0 ? "Cost mix" : "Cost";
}

function basisLabel(basis: ModelUsageCost["basis"]): string {
  if (basis === "estimated") return "API-equivalent estimate";
  if (basis === "usage") return "Plan usage";
  if (basis === "metered") return "Recorded cost";
  if (basis === "included") return "Included";
  if (basis === "local") return "Local";
  if (basis === "partial") return "Mixed cost types";
  return "Not priced";
}

function costCell(tokens: number, cost: number, basis: ModelUsageCost["basis"]): string {
  if (basis === "included") return `${formatCompactNumber(tokens)} · Included`;
  if (basis === "local") return `${formatCompactNumber(tokens)} · Local`;
  if (basis === "unavailable") return `${formatCompactNumber(tokens)} · Not priced`;
  if (basis === "estimated") {
    if (tokens === 0) return "0";
    return cost === 0 ? `${formatCompactNumber(tokens)} · Free API` : `${formatCompactNumber(tokens)} · ~${formatCellCost(cost)}`;
  }
  return `${formatCompactNumber(tokens)} · ${formatCellCost(cost)}`;
}

function UsageByModel({ models }: { models: ModelUsageRow[] }) {
  if (models.length === 0) return null;
  return (
    <div className="usage-model-table-wrap">
      <table className="usage-model-table">
        <caption>Usage by model. Token counts and recorded or estimated cost.</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cache</th><th scope="col">Output</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {models.map((row) => (
            <tr key={`${row.provider}/${row.model}`}>
              <th scope="row"><strong>{row.model}</strong><span>{providerLabel(row.provider)} · {basisLabel(row.cost.basis)}</span></th>
              <td data-label="Input">{costCell(row.tokens.input, row.cost.input, row.cost.basis)}</td>
              <td data-label="Cache">{costCell(row.tokens.cacheRead + row.tokens.cacheWrite, row.cost.cacheRead + row.cost.cacheWrite, row.cost.basis)}</td>
              <td data-label="Output">{costCell(row.tokens.output, row.cost.output, row.cost.basis)}</td>
              <td data-label="Total">{costCell(row.tokens.total, row.cost.total, row.cost.basis)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function compactionActive(operation: WorkerCompactionOperation | null | undefined): boolean {
  return operation?.status === "starting" || operation?.status === "running";
}

export function WorkerCompactionStatus({ operation, runtimeCompacting }: {
  operation: WorkerCompactionOperation | null;
  runtimeCompacting: boolean;
}) {
  if (operation?.status === "failed") return <p className="error" role="alert">Compaction needs attention: {operation.error}</p>;
  if (operation?.status === "completed") return <p role="status">Context compacted successfully.</p>;
  if (operation?.status === "running" || runtimeCompacting) return <p className="muted" role="status">Compacting context… This can take several minutes.</p>;
  if (operation?.status === "starting") return <p className="muted" role="status">Starting context compaction…</p>;
  return null;
}

type SessionControlsButtonProps = {
  pairId: string;
  lane: "butler" | "worker";
  disabled: boolean;
};

export function SessionControlsButton({ pairId, lane, disabled }: SessionControlsButtonProps) {
  const [open, setOpen] = useState(false);
  const [controls, setControls] = useState<WorkerSessionControls | null>(null);
  const [pending, setPending] = useState<WorkerSessionControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [entryId, setEntryId] = useState("");
  const loadRequest = useRef(0);
  const triggerLabel = `${lane === "butler" ? "Butler" : "Worker"} session controls`;
  const isCompacting = Boolean(controls?.compacting || compactionActive(controls?.manualCompaction));

  async function load() {
    const request = ++loadRequest.current;
    const payload = await getJson<{ controls: WorkerSessionControls }>(`/api/pairs/${encodeURIComponent(pairId)}/${lane}/controls`);
    if (request !== loadRequest.current) return;
    setControls(payload.controls);
    setEntryId((current) => payload.controls.forkPoints.some((point) => point.entryId === current) ? current : payload.controls.forkPoints.at(-1)?.entryId ?? "");
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void load().catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)));
  }, [open, pairId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  useEffect(() => {
    if (!open || lane !== "worker" || !compactionActive(controls?.manualCompaction)) return;
    let stopped = false;
    let checking = false;
    const poll = async () => {
      if (checking) return;
      checking = true;
      try {
        const payload = await getJson<{ operation: WorkerCompactionOperation | null }>(`/api/pairs/${encodeURIComponent(pairId)}/worker/controls/compaction`);
        if (stopped) return;
        setError(null);
        setControls((current) => current ? { ...current, manualCompaction: payload.operation } : current);
        if (payload.operation && !compactionActive(payload.operation)) await load();
      } catch (nextError) {
        if (!stopped) setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, pairId, lane, controls?.manualCompaction?.id, controls?.manualCompaction?.status]);

  async function run(action: WorkerSessionControlAction, body: Record<string, unknown> = {}) {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      if (action === "compact" && lane === "worker") {
        const payload = await postJson<{ operation: WorkerCompactionOperation }>(
          `/api/pairs/${encodeURIComponent(pairId)}/${lane}/controls/${action}`,
          body
        );
        loadRequest.current += 1;
        setControls((current) => current ? { ...current, manualCompaction: payload.operation } : current);
        setInstructions("");
      } else {
        await postJson(`/api/pairs/${encodeURIComponent(pairId)}/${lane}/controls/${action}`, body);
        await load();
        if (action === "compact") setInstructions("");
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <button className="icon-button" type="button" disabled={disabled} aria-label={triggerLabel} aria-haspopup="dialog" aria-expanded={open} title={triggerLabel} onClick={() => setOpen(true)}><SessionControlsIcon /></button>
      {open ? (
        <div className="worker-session-backdrop" role="presentation">
          <section className="worker-session-dialog" role="dialog" aria-modal="true" aria-label={`${lane === "butler" ? "Butler" : "Worker"} session controls`}>
            <header className="worker-session-head">
              <h2 id="worker-session-title">Session controls</h2>
              <button className="button" type="button" disabled={Boolean(pending)} onClick={() => setOpen(false)}>Close</button>
            </header>
            {!controls && !error ? <p className="muted">Loading session details…</p> : null}
            {controls?.stats ? (
              <>
                <dl className="worker-session-stats">
                  <div><dt>Messages</dt><dd>{formatNumber(controls.stats.totalMessages)}</dd></div>
                  <div><dt>Tool calls</dt><dd>{formatNumber(controls.stats.toolCalls)}</dd></div>
                  <div><dt>Tokens</dt><dd>{formatNumber(controls.stats.tokens.total)}</dd></div>
                  <div><dt>{summaryCostLabel(controls.stats.usage.cost)}</dt><dd>{formatUsageCost(controls.stats.usage.cost)}</dd></div>
                  <div><dt>Context</dt><dd>{controls.stats.contextUsage?.percent == null ? "—" : `${Math.round(controls.stats.contextUsage.percent)}%`}</dd></div>
                  <div><dt>Queued</dt><dd>{formatNumber(controls.pendingMessageCount)}</dd></div>
                </dl>
                <UsageByModel models={controls.stats.usage.models} />
                <p className="worker-session-cost-note">Ollama values use the model maker’s public API rate card as an equivalent estimate. They are not Ollama billing. When cache pricing is not published, cache tokens use the input rate. Long-context pricing tiers may differ.</p>
              </>
            ) : null}
            {controls ? (
              <div className="worker-session-sections">
                <section aria-busy={isCompacting}>
                  <h3>Context</h3>
                  <textarea className="input worker-session-instructions" value={instructions} placeholder="Optional compaction instructions" onChange={(event) => setInstructions(event.target.value)} />
                  <WorkerCompactionStatus operation={controls.manualCompaction} runtimeCompacting={controls.compacting} />
                  <div className="worker-session-actions">
                    <button className="button" type="button" disabled={controls.busy || isCompacting || Boolean(pending)} onClick={() => void run("compact", { instructions })}>{isCompacting ? "Compacting…" : "Compact now"}</button>
                    <button className="button" type="button" disabled={Boolean(pending)} onClick={() => void run("abort-retry")}>Cancel retry</button>
                    <a className="button" href={`/api/pairs/${encodeURIComponent(pairId)}/${lane}/export`}>Export HTML</a>
                  </div>
                </section>
                <section>
                  <h3>Branch</h3>
                  <div className="worker-session-row">
                    <select className="input" value={entryId} onChange={(event) => setEntryId(event.target.value)} aria-label="Branch point">
                      {controls.forkPoints.map((point) => <option key={point.entryId} value={point.entryId}>{point.text.slice(0, 110)}</option>)}
                    </select>
                    <button className="button" type="button" disabled={!entryId || controls.busy || isCompacting || Boolean(pending)} onClick={() => void run("fork", { entryId })}>Fork here</button>
                  </div>
                  <div className="worker-session-clone-action">
                    <button className="button" type="button" disabled={!controls.leafId || controls.busy || isCompacting || Boolean(pending)} onClick={() => void run("clone")}>Clone active branch</button>
                  </div>
                </section>
              </div>
            ) : null}
            {error ? <p className="error" role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

export function WorkerSessionControlsButton({ pairId, disabled }: { pairId: string; disabled: boolean }) {
  return <SessionControlsButton pairId={pairId} lane="worker" disabled={disabled} />;
}
