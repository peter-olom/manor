import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { deleteJson, getJson, postJson, putJson } from "./api";

type RuntimeEgressDomain = {
  domain: string;
  source: "built-in" | "operator";
  removable: boolean;
};

type RuntimeEgressResponse = {
  mode: "internet" | "restricted";
  domains: RuntimeEgressDomain[];
};

function displayDomain(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

function domainScope(domain: string): string {
  return domain.startsWith(".") ? "Host and subdomains" : "Exact host";
}

export function RuntimeEgressDashboard({ active }: { active: boolean }) {
  const [domains, setDomains] = useState<RuntimeEgressDomain[]>([]);
  const [mode, setMode] = useState<"internet" | "restricted">("internet");
  const [hostname, setHostname] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPolicyLoaded(false);
    setError(null);
    try {
      const response = await getJson<RuntimeEgressResponse>("/api/runtime-egress/domains");
      setDomains(response.domains);
      setMode(response.mode);
      setPolicyLoaded(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const builtInDomains = useMemo(() => domains.filter((domain) => domain.source === "built-in"), [domains]);
  const operatorDomains = useMemo(() => domains.filter((domain) => domain.source === "operator"), [domains]);

  async function addDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = hostname.trim().toLowerCase();
    if (!normalized) return;
    const domain = includeSubdomains ? `.${normalized.replace(/^\./, "")}` : normalized.replace(/^\./, "");
    setBusyDomain(domain);
    setError(null);
    setMessage(null);
    try {
      const response = await postJson<RuntimeEgressResponse>("/api/runtime-egress/domains", { domain });
      setDomains(response.domains);
      setHostname("");
      setIncludeSubdomains(false);
      setMessage(`${displayDomain(domain)} was added to the Restricted-mode allowlist.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDomain(null);
    }
  }

  async function changeMode(nextMode: "internet" | "restricted") {
    setBusyDomain("mode");
    setError(null);
    setMessage(null);
    try {
      const response = await putJson<RuntimeEgressResponse>("/api/runtime-egress/mode", { mode: nextMode });
      setMode(response.mode);
      setDomains(response.domains);
      setMessage(nextMode === "internet" ? "The shared proxy can reach the public internet." : "The shared proxy is limited to its allowlist.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDomain(null);
    }
  }

  async function removeDomain(domain: string) {
    setBusyDomain(domain);
    setError(null);
    setMessage(null);
    try {
      const response = await deleteJson<RuntimeEgressResponse>(`/api/runtime-egress/domains/${encodeURIComponent(domain)}`);
      setDomains(response.domains);
      setMessage(`${displayDomain(domain)} was removed from the Restricted-mode allowlist.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDomain(null);
    }
  }

  return (
    <div className={`settings-subgroup runtime-egress-dashboard${active ? " is-active" : ""}`} aria-labelledby="runtime-egress-title">
      <div className="settings-subgroup-head">
        <div>
          <h3 id="runtime-egress-title">Runtime egress</h3>
          <p>Optional outbound restrictions for Butler and Worker. This is separate from CAR. New proxy requests use changes immediately; existing connections may stay open.</p>
        </div>
      </div>
      <div className="settings-subgroup-body">

        {error ? <div className="settings-error runtime-egress-feedback" role="alert">{error}</div> : null}
        {message ? <div className="runtime-egress-success runtime-egress-feedback" role="status">{message}</div> : null}

        <label className="settings-field is-wide">
          <span className="settings-field-label">Shared Butler and Worker proxy</span>
          <select value={policyLoaded ? mode : ""} onChange={(event) => void changeMode(event.target.value === "restricted" ? "restricted" : "internet")} disabled={!policyLoaded || busyDomain !== null}>
            {!policyLoaded ? <option value="" disabled>{loading ? "Loading current policy…" : "Current policy unavailable"}</option> : null}
            <option value="internet">Internet — public HTTP and HTTPS</option>
            <option value="restricted">Restricted — allowlisted hosts only</option>
          </select>
          <small>Internet allows public destinations through the proxy. Restricted allows only built-in and operator-added hosts. The proxy blocks private and internal destinations in both modes.</small>
        </label>

        <div className="settings-scope-grid" aria-label="Runtime egress scope">
          <div className="settings-scope-card">
            <strong>Egress control applies to</strong>
            <p>Outbound HTTP and HTTPS from Butler and Worker clients that use Manor's configured proxy. Worker has no direct public network, so clients that ignore the proxy normally fail.</p>
          </div>
          <div className="settings-scope-card">
            <strong>Egress control does not apply to</strong>
            <p>Playwright browser and desktop proof sessions, preview runtimes, Docker image pulls, Ollama pulls, host traffic, or named Manor services that bypass the proxy. Butler software can also bypass it by opening a direct connection.</p>
          </div>
        </div>

        <form className="runtime-egress-form" onSubmit={addDomain}>
          <label className="settings-field is-wide">
            <span className="settings-field-label">Restricted-mode hostname</span>
            <input
              className="input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="api.example.com"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              disabled={!policyLoaded || busyDomain !== null}
            />
            <small>Used only in Restricted mode. Enter a hostname; URLs, paths, IP addresses, and wildcards are rejected.</small>
          </label>
          <label className="settings-toggle runtime-egress-subdomains">
            <span className="settings-toggle-text">
              <span className="settings-toggle-label">Include subdomains</span>
              <small>Also allow the hostname itself.</small>
            </span>
            <input type="checkbox" checked={includeSubdomains} onChange={(event) => setIncludeSubdomains(event.target.checked)} disabled={!policyLoaded || busyDomain !== null} />
          </label>
          <button className="button is-primary" type="submit" disabled={!policyLoaded || !hostname.trim() || busyDomain !== null}>
            {busyDomain ? "Applying…" : "Allow hostname"}
          </button>
        </form>

        <section className="runtime-egress-list-section" aria-labelledby="custom-egress-title">
          <div className="runtime-egress-list-head">
            <div><h4 id="custom-egress-title">Restricted-mode allowlist</h4><p>These entries have no effect while Internet mode is selected.</p></div>
            <span>{operatorDomains.length}</span>
          </div>
          {loading ? <div className="runtime-egress-empty">Loading network access…</div> : operatorDomains.length === 0 ? (
            <div className="runtime-egress-empty">No custom hostnames are configured for Restricted mode.</div>
          ) : (
            <div className="runtime-egress-list" role="list">
              {operatorDomains.map((entry) => (
                <div className="runtime-egress-row" role="listitem" key={entry.domain}>
                  <span><strong>{displayDomain(entry.domain)}</strong><small>{domainScope(entry.domain)}</small></span>
                  <button className="button is-danger" type="button" disabled={!policyLoaded || busyDomain !== null} onClick={() => void removeDomain(entry.domain)}>
                    {busyDomain === entry.domain ? "Removing…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <details className="runtime-egress-built-ins">
          <summary>Built-in Restricted-mode access <span>{builtInDomains.length}</span></summary>
          <p>Manor requires these hosts for bundled services when Restricted mode is selected. They cannot be removed here.</p>
          <div className="runtime-egress-built-in-list">
            {builtInDomains.map((entry) => <code key={entry.domain}>{entry.domain}</code>)}
          </div>
        </details>
      </div>
    </div>
  );
}
