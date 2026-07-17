import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { deleteJson, getJson, postJson } from "./api";

type RuntimeEgressDomain = {
  domain: string;
  source: "built-in" | "operator";
  removable: boolean;
};

type RuntimeEgressResponse = {
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
  const [hostname, setHostname] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyDomain, setBusyDomain] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getJson<RuntimeEgressResponse>("/api/runtime-egress/domains");
      setDomains(response.domains);
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
      setMessage(`${displayDomain(domain)} is allowed for Butler and Worker.`);
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
      setMessage(`${displayDomain(domain)} is blocked again.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyDomain(null);
    }
  }

  return (
    <div className={`runtime-egress-dashboard${active ? " is-active" : ""}`}>
      <section className="settings-section" aria-labelledby="runtime-egress-title">
        <header className="settings-section-head">
          <div>
            <h2 id="runtime-egress-title">Runtime egress</h2>
            <p>Allow trusted internet hosts for Butler and Worker. Changes apply immediately across the shared runtime.</p>
          </div>
        </header>

        {error ? <div className="settings-error runtime-egress-feedback" role="alert">{error}</div> : null}
        {message ? <div className="runtime-egress-success runtime-egress-feedback" role="status">{message}</div> : null}

        <form className="runtime-egress-form" onSubmit={addDomain}>
          <label className="settings-field is-wide">
            <span className="settings-field-label">Hostname</span>
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
              disabled={busyDomain !== null}
            />
            <small>Enter a hostname only. URLs, paths, IP addresses, and wildcards are rejected.</small>
          </label>
          <label className="settings-toggle runtime-egress-subdomains">
            <span className="settings-toggle-text">
              <span className="settings-toggle-label">Include subdomains</span>
              <small>Also allow the hostname itself.</small>
            </span>
            <input type="checkbox" checked={includeSubdomains} onChange={(event) => setIncludeSubdomains(event.target.checked)} disabled={busyDomain !== null} />
          </label>
          <button className="button is-primary" type="submit" disabled={!hostname.trim() || busyDomain !== null}>
            {busyDomain ? "Applying…" : "Allow hostname"}
          </button>
        </form>

        <section className="runtime-egress-list-section" aria-labelledby="custom-egress-title">
          <div className="runtime-egress-list-head">
            <div><h3 id="custom-egress-title">Added access</h3><p>Remove a hostname when the CLI no longer needs it.</p></div>
            <span>{operatorDomains.length}</span>
          </div>
          {loading ? <div className="runtime-egress-empty">Loading network access…</div> : operatorDomains.length === 0 ? (
            <div className="runtime-egress-empty">No custom hostnames are allowed.</div>
          ) : (
            <div className="runtime-egress-list" role="list">
              {operatorDomains.map((entry) => (
                <div className="runtime-egress-row" role="listitem" key={entry.domain}>
                  <span><strong>{displayDomain(entry.domain)}</strong><small>{domainScope(entry.domain)}</small></span>
                  <button className="button is-danger" type="button" disabled={busyDomain !== null} onClick={() => void removeDomain(entry.domain)}>
                    {busyDomain === entry.domain ? "Removing…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <details className="runtime-egress-built-ins">
          <summary>Built-in access <span>{builtInDomains.length}</span></summary>
          <p>Manor requires these hosts for its bundled services. They cannot be removed here.</p>
          <div className="runtime-egress-built-in-list">
            {builtInDomains.map((entry) => <code key={entry.domain}>{entry.domain}</code>)}
          </div>
        </details>
      </section>
    </div>
  );
}
