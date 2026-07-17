import { useCallback, useEffect, useRef, useState } from "react";

import { getJson, postJson } from "./api";
import type { ModelUsageCost, ModelUsageRange, ModelUsageResponse } from "../shared/model-usage";

const RANGES: Array<{ value: ModelUsageRange; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" }
];

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
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

function costLabel(cost: ModelUsageCost): string {
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

function cell(tokens: number, cost: number, basis: ModelUsageCost["basis"]): string {
  if (basis === "included") return `${formatCompactNumber(tokens)} · Included`;
  if (basis === "local") return `${formatCompactNumber(tokens)} · Local`;
  if (basis === "unavailable") return `${formatCompactNumber(tokens)} · Not priced`;
  if (basis === "estimated") {
    if (tokens === 0) return "0";
    return cost === 0 ? `${formatCompactNumber(tokens)} · Free API` : `${formatCompactNumber(tokens)} · ~${formatCellCost(cost)}`;
  }
  return `${formatCompactNumber(tokens)} · ${formatCellCost(cost)}`;
}

function requestLabel(value: number): string {
  return `${value} ${value === 1 ? "request" : "requests"}`;
}

function modelLabel(value: number): string {
  return `${value} ${value === 1 ? "model" : "models"}`;
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

export function UsageDashboard({ active }: { active: boolean }) {
  const [range, setRange] = useState<ModelUsageRange>("7d");
  const [breakdown, setBreakdown] = useState<"models" | "providers">("models");
  const [data, setData] = useState<ModelUsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getJson<ModelUsageResponse>(`/api/model-usage?range=${range}`));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    if (!confirmReset) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resetting) setConfirmReset(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmReset, resetting]);

  async function resetUsage() {
    setResetting(true);
    setError(null);
    try {
      await postJson("/api/model-usage/reset", {});
      setConfirmReset(false);
      await load();
      resetTriggerRef.current?.focus();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setResetting(false);
    }
  }

  const summary = data?.summary ?? null;
  return (
    <div className="settings-page usage-dashboard" aria-label="Usage settings">
      <div className="settings-content">
        <section className="settings-section">
          <header className="settings-section-head usage-head">
            <div><h2>Usage</h2><p>Interactive model usage across Butler and Workers.</p></div>
            <div className="usage-range" role="group" aria-label="Usage period">
              {RANGES.map((option) => <button key={option.value} type="button" className={range === option.value ? "is-selected" : ""} aria-pressed={range === option.value} onClick={() => setRange(option.value)}>{option.label}</button>)}
            </div>
          </header>
          <div className="settings-section-body usage-body">
            {error ? <div className="settings-error settings-feedback" role="alert">{error}<button className="button" type="button" onClick={() => void load()}>Retry</button></div> : null}
            {loading && !summary ? <div className="settings-empty" role="status">Loading usage…</div> : null}
            {summary ? (
              <>
                <dl className="usage-summary">
                  <div><dt>{summaryCostLabel(summary.cost)}</dt><dd>{costLabel(summary.cost)}</dd></div>
                  <div><dt>Input tokens</dt><dd>{formatNumber(summary.tokens.input)}</dd></div>
                  <div><dt>Output tokens</dt><dd>{formatNumber(summary.tokens.output)}</dd></div>
                  <div><dt>Cache tokens</dt><dd>{formatNumber(summary.tokens.cacheRead + summary.tokens.cacheWrite)}</dd></div>
                  <div><dt>Requests</dt><dd>{formatNumber(summary.requests)}</dd></div>
                  <div><dt>Sessions</dt><dd>{formatNumber(summary.sessions)}</dd></div>
                </dl>
                {summary.models.length > 0 ? (
                  <>
                    <div className="usage-breakdown-head">
                      <h3>Breakdown</h3>
                      <div className="usage-breakdown-toggle" role="group" aria-label="Group usage by">
                        <button type="button" className={breakdown === "models" ? "is-selected" : ""} aria-pressed={breakdown === "models"} onClick={() => setBreakdown("models")}>Models</button>
                        <button type="button" className={breakdown === "providers" ? "is-selected" : ""} aria-pressed={breakdown === "providers"} onClick={() => setBreakdown("providers")}>Providers</button>
                      </div>
                    </div>
                    <div className="usage-model-table-wrap">
                    <table className="usage-model-table">
                      <caption>{breakdown === "models" ? "Model" : "Provider"} usage for the selected period</caption>
                      <thead><tr><th scope="col">{breakdown === "models" ? "Model" : "Provider"}</th><th scope="col">Input</th><th scope="col">Cache</th><th scope="col">Output</th><th scope="col">Total</th></tr></thead>
                      <tbody>{(breakdown === "models" ? summary.models : summary.providers).map((row) => (
                        <tr key={"model" in row ? `${row.provider}/${row.model}` : row.provider}>
                          <th scope="row"><strong>{"model" in row ? row.model : providerLabel(row.provider)}</strong><span>{"model" in row ? providerLabel(row.provider) : modelLabel(row.modelCount)} · {basisLabel(row.cost.basis)} · {requestLabel(row.requests)}</span></th>
                          <td data-label="Input">{cell(row.tokens.input, row.cost.input, row.cost.basis)}</td>
                          <td data-label="Cache">{cell(row.tokens.cacheRead + row.tokens.cacheWrite, row.cost.cacheRead + row.cost.cacheWrite, row.cost.basis)}</td>
                          <td data-label="Output">{cell(row.tokens.output, row.cost.output, row.cost.basis)}</td>
                          <td data-label="Total">{cell(row.tokens.total, row.cost.total, row.cost.basis)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                  </>
                ) : <div className="settings-empty">No model usage recorded for this period.</div>}
                <p className="usage-note">Ollama estimates use each model maker’s public API rate card; they are not Ollama billing. When a maker does not publish cache pricing, cache tokens use its input rate. Flat estimates use the standard context tier, so long-context tiers may differ. OpenCode Go reflects dollar-denominated plan usage. Codex values are list-price estimates. Local models without an exact hosted rate remain Local. Background model tasks are not included.</p>
                {data?.resetAt ? <p className="usage-reset-date">Stats reset on {new Date(data.resetAt).toLocaleString()}.</p> : null}
              </>
            ) : null}
          </div>
        </section>
        <section className="usage-reset-section">
          <div><h3>Usage history</h3><p>Start Manor’s usage counters again without deleting sessions or changing provider billing.</p></div>
          <button ref={resetTriggerRef} className="button is-danger" type="button" onClick={() => setConfirmReset(true)}>Reset usage history…</button>
        </section>
      </div>
      {confirmReset ? (
        <div className="worker-session-backdrop" role="presentation">
          <section className="usage-reset-dialog" role="alertdialog" aria-modal="true" aria-labelledby="usage-reset-title" aria-describedby="usage-reset-description">
            <h2 id="usage-reset-title">Reset usage history?</h2>
            <p id="usage-reset-description">This starts Manor’s usage counters from today. It does not delete sessions or change provider billing.</p>
            <div className="usage-reset-actions">
              <button className="button" type="button" autoFocus disabled={resetting} onClick={() => { setConfirmReset(false); resetTriggerRef.current?.focus(); }}>Cancel</button>
              <button className="button is-danger" type="button" disabled={resetting} onClick={() => void resetUsage()}>{resetting ? "Resetting…" : "Reset usage history"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
