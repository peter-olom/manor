import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getJson, patchJson, postJson } from "./api";
import { SetupTabIcon, WarningIcon } from "./icons";
import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsProviderAvailabilityMap,
  SettingsSecretSource,
  SettingsValidationKey,
  SettingsValidationMap
} from "../shared/settings";

type ModelOption = { id: string; label: string; provider: string | null };
type AuthStatusView = { mode: "chatgpt" | "api" | "none" | "unknown"; loggedIn: boolean; validationError: string | null; lastValidatedAt: number | null };
type OllamaPullEvent = { status?: string; digest?: string; total?: number; completed?: number; error?: string; warning?: boolean; done?: boolean };
type SettingsResponse = {
  settings: ManorSettings;
  provenance: ManorSettingsProvenance;
  availableModels: {
    butler: ModelOption[];
    codex: ModelOption[];
    piRpc: ModelOption[];
    ollamaLocal: ModelOption[];
    opencodeGo: ModelOption[];
    worker: { availableModels: ModelOption[] };
  };
  providerAvailability: SettingsProviderAvailabilityMap;
  openaiCodexAuth?: { butler: AuthStatusView; codex: AuthStatusView };
  validation: SettingsValidationMap;
};

const GROUP_LABELS: Record<SettingsGroupKey, string> = {
  overview: "Overview",
  "providers.ollamaLocal": "Ollama Local",
  "providers.ollamaCloud": "Ollama Cloud",
  "providers.opencodeGo": "OpenCode Go",
  worker: "Worker",
  butler: "Butler",
  modelTasks: "Model tasks",
  memory: "Memory",
  embeddings: "Embeddings"
};

const VALIDATION_TARGETS: SettingsValidationKey[] = [
  "codex",
  "piRpc",
  "ollamaLocal",
  "ollamaCloud",
  "opencodeGo",
  "ollamaWebSearch",
  "ollamaWebFetch",
  "opencodeWebSearch",
  "opencodeWebFetch",
  "memoryEmbeddings"
];

const VALIDATION_LABELS: Record<SettingsValidationKey, string> = {
  codex: "OpenAI / Codex runtime",
  piRpc: "Pi RPC",
  ollamaLocal: "Ollama Local",
  ollamaCloud: "Ollama Cloud",
  opencodeGo: "OpenCode Go",
  ollamaWebSearch: "Ollama web search",
  ollamaWebFetch: "Ollama web fetch",
  opencodeWebSearch: "OpenCode web search",
  opencodeWebFetch: "OpenCode web fetch",
  memoryEmbeddings: "Embeddings"
};

export type SettingsSectionId = "overview" | "providers" | "runtime" | "memory" | "diagnostics";
export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; description: string }[] = [
  { id: "overview", label: "Overview", description: "Operator and provider defaults" },
  { id: "providers", label: "Providers", description: "Model and tool access" },
  { id: "runtime", label: "Runtime", description: "Worker and Butler defaults" },
  { id: "memory", label: "Memory", description: "Synthesis and embeddings" },
  { id: "diagnostics", label: "Diagnostics", description: "Connection tests" }
];

const SECTION_HELP: Record<SettingsSectionId, string> = {
  overview: "Set the operator name and which provider Butler and Codex should use.",
  providers: "Configure the model providers (OpenAI/Codex, Ollama Local, Ollama Cloud, OpenCode Go) and web tools Butler can use.",
  runtime: "Choose where work runs, which models handle routine tasks, and how much thinking to spend.",
  memory: "Tune synthesis, promotion, semantic review, and embedding backfill behavior.",
  diagnostics: "Run connection checks for the services Butler depends on."
};

function cloneSettings(settings: ManorSettings): ManorSettings {
  return JSON.parse(JSON.stringify(settings)) as ManorSettings;
}

function modelValue(option: ModelOption): string {
  return option.provider && !option.id.startsWith(`${option.provider}/`) ? `${option.provider}/${option.id}` : option.id;
}

function secretLabel(source: SettingsSecretSource): string {
  if (source.type === "env") return `env:${source.name}`;
  if (source.type === "file") return `file-env:${source.pathEnv}`;
  return `asiri:${source.workspace}:${source.path}`;
}

type ProviderKey = "openai-codex" | "ollama-local" | "ollama-cloud" | "opencode-go";

function providerModels(models: ModelOption[], providerId: string): ModelOption[] {
  return models.filter((model) => model.provider === providerId);
}

function groupModelsByProvider(models: ModelOption[]): { provider: string; options: ModelOption[] }[] {
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    const key = model.provider ?? "default";
    const list = groups.get(key) ?? [];
    list.push(model);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([provider, options]) => ({ provider, options }));
}

function StatusPill({ status }: { status: string }) {
  return <span className={`settings-status is-${status}`}>{status.replace(/_/g, " ")}</span>;
}

function formatAuthSummary(auth?: AuthStatusView): string {
  if (!auth) return "Unknown";
  if (!auth.loggedIn) return auth.validationError ? `Not signed in — ${auth.validationError}` : "Not signed in";
  if (auth.mode === "chatgpt") return "Signed in with ChatGPT";
  if (auth.mode === "api") return "Signed in with API key";
  return "Signed in";
}

function availableProviderOptions(availability: SettingsProviderAvailabilityMap): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  if (availability["openai-codex"].secretAvailable) options.push({ value: "openai-codex", label: "OpenAI / Codex" });
  if (availability["ollama-local"].secretAvailable && availability["ollama-local"].enabled) options.push({ value: "ollama-local", label: "Ollama Local" });
  if (availability["ollama-cloud"].secretAvailable && availability["ollama-cloud"].enabled) options.push({ value: "ollama-cloud", label: "Ollama Cloud" });
  if (availability["opencode-go"].secretAvailable && availability["opencode-go"].enabled) options.push({ value: "opencode-go", label: "OpenCode Go" });
  return options;
}

function Field({
  label,
  children,
  hint,
  wide
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={`settings-field ${wide ? "is-wide" : ""}`}>
      <span className="settings-field-label">{label}</span>
      {children}
      {hint ? <small>{hint}</small> : <small className="settings-control-spacer" aria-hidden="true">&nbsp;</small>}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span className="settings-toggle-text">
        <span className="settings-toggle-label">{label}</span>
        {hint ? <small>{hint}</small> : <small className="settings-control-spacer" aria-hidden="true">&nbsp;</small>}
      </span>
      <span className="settings-switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="settings-switch-track" aria-hidden="true" />
      </span>
    </label>
  );
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="settings-grid">{children}</div>;
}

function ToggleGrid({ children }: { children: ReactNode }) {
  return <div className="settings-toggle-grid">{children}</div>;
}

const PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI / Codex",
  "openai": "OpenAI",
  "ollama-local": "Ollama Local",
  "ollama-cloud": "Ollama Cloud",
  "opencode-go": "OpenCode Go"
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function ModelSelectField({
  label,
  hint,
  value,
  models,
  available,
  onChange,
  disabled
}: {
  label: string;
  hint?: string;
  value: string | null;
  models: ModelOption[];
  available: SettingsProviderAvailabilityMap | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}) {
  const filtered = available
    ? models.filter((model) => {
        const entry = available[(model.provider ?? "openai-codex") as ProviderKey];
        return !entry || entry.secretAvailable;
      })
    : models;
  const groups = groupModelsByProvider(filtered);
  return (
    <Field label={label} hint={hint}>
      <select
        value={value ?? ""}
        disabled={disabled || filtered.length === 0}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Model default</option>
        {groups.map((group) => (
          <optgroup key={group.provider} label={providerLabel(group.provider)}>
            {group.options.map((model) => {
              const ref = modelValue(model);
              return <option key={ref} value={ref}>{model.label}</option>;
            })}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

function Section({
  id,
  title,
  provenance,
  actions,
  children
}: {
  id: SettingsSectionId;
  title: string;
  provenance?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section" id={`settings-section-${id}`}>
      <header className="settings-section-head">
        <div>
          <h2>{title}</h2>
          <p>{SECTION_HELP[id]}</p>
        </div>
        <div className="settings-section-head-actions">
          {provenance ? <span className="settings-provenance">{provenance}</span> : null}
          {actions}
        </div>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function SubGroup({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-subgroup">
      <div className="settings-subgroup-head">
        <div>
          <h3>{title}</h3>
        </div>
        {actions ? <div className="settings-subgroup-head-actions">{actions}</div> : null}
      </div>
      <div className="settings-subgroup-body">{children}</div>
    </div>
  );
}

function SecretSourceEditor({
  value,
  onChange
}: {
  value: SettingsSecretSource;
  onChange: (value: SettingsSecretSource) => void;
}) {
  const mode = value.type;
  return (
    <div className="settings-secret-source">
      <select
        value={mode}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "file") onChange({ type: "file", pathEnv: "OLLAMA_API_KEY_FILE" });
          else if (next === "asiri") onChange({ type: "asiri", workspace: "", path: "" });
          else onChange({ type: "env", name: "OLLAMA_API_KEY" });
        }}
        aria-label="Secret source type"
      >
        <option value="env">Env</option>
        <option value="file">File env</option>
        <option value="asiri">Asiri</option>
      </select>
      {value.type === "env" ? (
        <input value={value.name} onChange={(event) => onChange({ type: "env", name: event.target.value })} aria-label="Secret env name" />
      ) : value.type === "file" ? (
        <input value={value.pathEnv} onChange={(event) => onChange({ type: "file", pathEnv: event.target.value })} aria-label="Secret file env name" />
      ) : (
        <>
          <input value={value.workspace} onChange={(event) => onChange({ ...value, workspace: event.target.value })} aria-label="Asiri workspace" />
          <input value={value.path} onChange={(event) => onChange({ ...value, path: event.target.value })} aria-label="Asiri path" />
        </>
      )}
    </div>
  );
}

function settingsEqual(a: ManorSettings, b: ManorSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SettingsDashboard({ activeSection }: { activeSection: SettingsSectionId }) {
  const [payload, setPayload] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<ManorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState<SettingsValidationKey | null>(null);
  const [validatingAll, setValidatingAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [providerTab, setProviderTab] = useState<"openai" | "ollamaLocal" | "ollama" | "opencode">(() => {
    if (typeof window === "undefined") return "openai";
    const param = new URLSearchParams(window.location.search).get("provider");
    if (param === "ollama-local") return "ollamaLocal";
    return param === "ollama" || param === "opencode" ? param : "openai";
  });
  const [authPending, setAuthPending] = useState<"butler" | "codex" | null>(null);
  const [authUrl, setAuthUrl] = useState<{ side: "butler" | "codex"; url: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [ollamaLocalModels, setOllamaLocalModels] = useState<{ id: string; contextWindow: number | null; capabilities?: string[] }[] | null>(null);
  const [ollamaLocalModelsLoading, setOllamaLocalModelsLoading] = useState(false);
  const [ollamaLocalModelsError, setOllamaLocalModelsError] = useState<string | null>(null);
  const [ollamaPullModel, setOllamaPullModel] = useState("");
  const [ollamaPulling, setOllamaPulling] = useState(false);
  const [ollamaPullStatus, setOllamaPullStatus] = useState<string | null>(null);
  const [ollamaPullProgress, setOllamaPullProgress] = useState<{ completed: number; total: number } | null>(null);
  const [ollamaPullError, setOllamaPullError] = useState<string | null>(null);
  const [ollamaPullWarning, setOllamaPullWarning] = useState(false);
  const [ollamaPullDone, setOllamaPullDone] = useState(false);
  const ollamaPullAbortRef = useRef<AbortController | null>(null);
  const [ollamaModels, setOllamaModels] = useState<{ id: string; contextWindow: number | null }[] | null>(null);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState<string | null>(null);
  const [opencodeModels, setOpencodeModels] = useState<{ id: string }[] | null>(null);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [opencodeModelsError, setOpencodeModelsError] = useState<string | null>(null);

  const workerModels = useMemo(() => payload?.availableModels.worker.availableModels ?? [], [payload]);
  const butlerModels = useMemo(() => payload?.availableModels.butler ?? [], [payload]);

  const dirty = Boolean(draft && payload && !settingsEqual(draft, payload.settings));

  const load = useCallback(async () => {
    const next = await getJson<SettingsResponse>("/api/settings");
    setPayload(next);
    setDraft(cloneSettings(next.settings));
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("provider", providerTab === "ollamaLocal" ? "ollama-local" : providerTab);
    window.history.replaceState(null, "", url.toString());
  }, [providerTab]);

  useEffect(() => {
    if (payload?.providerAvailability["ollama-local"].enabled && !ollamaLocalModels && !ollamaLocalModelsLoading) {
      void fetchOllamaLocalModels();
    }
  }, [payload, ollamaLocalModels, ollamaLocalModelsLoading]);

  useEffect(() => {
    if (payload?.providerAvailability["ollama-cloud"].secretAvailable && !ollamaModels && !ollamaModelsLoading) {
      void fetchOllamaModels();
    }
  }, [payload, ollamaModels, ollamaModelsLoading]);

  useEffect(() => {
    if (payload?.providerAvailability["opencode-go"].secretAvailable && !opencodeModels && !opencodeModelsLoading) {
      void fetchOpencodeModels();
    }
  }, [payload, opencodeModels, opencodeModelsLoading]);

  const update = useCallback((mutate: (settings: ManorSettings) => void) => {
    setMessage(null);
    setDraft((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      mutate(next);
      return next;
    });
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await patchJson<SettingsResponse>("/api/settings", draft);
      setPayload(next);
      setDraft(cloneSettings(next.settings));
      setMessage("Saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function reseed() {
    setSaving(true);
    setMessage(null);
    try {
      const next = await postJson<SettingsResponse>("/api/settings/reseed", {});
      setPayload(next);
      setDraft(cloneSettings(next.settings));
      setMessage("Reseed complete");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function startAuth(side: "butler" | "codex") {
    setAuthPending(side);
    setAuthError(null);
    setAuthUrl(null);
    try {
      const result = await postJson<{ authUrl: string; startedAt: number }>(`/api/auth/${side}/device`, {});
      setAuthUrl({ side, url: result.authUrl });
      window.open(result.authUrl, "_blank", "noopener");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthPending(null);
    }
  }

  async function refreshAuth() {
    setMessage(null);
    try {
      const next = await getJson<SettingsResponse>("/api/settings");
      setPayload(next);
      setDraft(cloneSettings(next.settings));
      setAuthUrl(null);
      setAuthError(null);
      setMessage("Auth status refreshed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function fetchOllamaModels() {
    setOllamaModelsLoading(true);
    setOllamaModelsError(null);
    try {
      const res = await getJson<{ models: { id: string; contextWindow: number | null }[] }>("/api/settings/providers/ollama-cloud/models");
      setOllamaModels(res.models);
    } catch (error) {
      setOllamaModelsError(error instanceof Error ? error.message : String(error));
      setOllamaModels([]);
    } finally {
      setOllamaModelsLoading(false);
    }
  }

  async function fetchOllamaLocalModels() {
    setOllamaLocalModelsLoading(true);
    setOllamaLocalModelsError(null);
    try {
      const res = await getJson<{ models: { id: string; contextWindow: number | null; capabilities?: string[] }[] }>("/api/settings/providers/ollama-local/models");
      setOllamaLocalModels(res.models);
    } catch (error) {
      setOllamaLocalModelsError(error instanceof Error ? error.message : String(error));
      setOllamaLocalModels([]);
    } finally {
      setOllamaLocalModelsLoading(false);
    }
  }

  async function pullOllamaLocalModel() {
    const model = ollamaPullModel.trim();
    if (!model || ollamaPulling || !payload?.settings.providers.ollamaLocal.enabled) return;
    const controller = new AbortController();
    ollamaPullAbortRef.current = controller;
    setOllamaPulling(true);
    setOllamaPullError(null);
    setOllamaPullWarning(false);
    setOllamaPullDone(false);
    setOllamaPullProgress(null);
    setOllamaPullStatus(`Pulling ${model}...`);
    try {
      const response = await fetch("/api/settings/providers/ollama-local/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `Pull failed with HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Pull did not return a progress stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawWarning = false;
      let latestStatus: string | null = null;
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: OllamaPullEvent;
        try {
          event = JSON.parse(trimmed) as OllamaPullEvent;
        } catch {
          event = { status: trimmed };
        }
        if (event.error) throw new Error(event.error);
        if (event.warning) {
          sawWarning = true;
          setOllamaPullWarning(true);
        }
        if (event.status) {
          latestStatus = event.status;
          setOllamaPullStatus(event.status);
        }
        if (typeof event.completed === "number" && typeof event.total === "number" && event.total > 0) {
          setOllamaPullProgress({ completed: event.completed, total: event.total });
        }
        if (event.done) setOllamaPullDone(true);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      }
      buffer += decoder.decode();
      handleLine(buffer);

      setOllamaPullDone(true);
      if (!sawWarning && !latestStatus) setOllamaPullStatus("Pull complete.");
      if (!sawWarning) setOllamaPullModel("");
      await fetchOllamaLocalModels();
      const next = await getJson<SettingsResponse>("/api/settings");
      setPayload(next);
      setDraft(cloneSettings(next.settings));
    } catch (error) {
      setOllamaPullError(controller.signal.aborted ? "Pull cancelled." : error instanceof Error ? error.message : String(error));
    } finally {
      if (ollamaPullAbortRef.current === controller) ollamaPullAbortRef.current = null;
      setOllamaPulling(false);
    }
  }

  async function fetchOpencodeModels() {
    setOpencodeModelsLoading(true);
    setOpencodeModelsError(null);
    try {
      const res = await getJson<{ models: { id: string }[] }>("/api/settings/providers/opencode-go/models");
      setOpencodeModels(res.models);
    } catch (error) {
      setOpencodeModelsError(error instanceof Error ? error.message : String(error));
      setOpencodeModels([]);
    } finally {
      setOpencodeModelsLoading(false);
    }
  }

  async function validate(target: SettingsValidationKey) {
    setValidating(target);
    setMessage(null);
    try {
      const next = await postJson<SettingsResponse>("/api/settings/validate", { target });
      setPayload(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setValidating(null);
    }
  }

  async function validateAll() {
    setValidatingAll(true);
    setMessage(null);
    try {
      for (const target of VALIDATION_TARGETS) {
        const next = await postJson<SettingsResponse>("/api/settings/validate", { target });
        setPayload(next);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setValidatingAll(false);
    }
  }

  async function restoreGroup(group: SettingsGroupKey) {
    setSaving(true);
    setMessage(null);
    try {
      const next = await postJson<SettingsResponse>("/api/settings/restore-group", { group });
      setPayload(next);
      setDraft(cloneSettings(next.settings));
      setMessage("Restored defaults");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const validationEntries = useMemo(
    () => VALIDATION_TARGETS.map((target) => ({ target, label: VALIDATION_LABELS[target], result: payload?.validation[target] })),
    [payload]
  );
  const failingCount = validationEntries.filter((entry) => entry.result?.status === "failed").length;
  const okCount = validationEntries.filter((entry) => entry.result?.status === "ok").length;
  const unconfiguredCount = validationEntries.filter((entry) => entry.result?.status === "not_configured").length;

  if (!draft || !payload) {
    return (
      <div className="settings-page">
        <div className="settings-empty">Loading settings...</div>
      </div>
    );
  }

  const savedMessage = message === "Saved" || message === "Reseed complete" ? message : null;
  const errorMessage = message && !savedMessage ? message : null;
  const testing = validatingAll || Boolean(validating);
  const pullPercent = ollamaPullProgress ? Math.max(0, Math.min(100, (ollamaPullProgress.completed / ollamaPullProgress.total) * 100)) : null;
  const ollamaLocalPullEnabled = payload.settings.providers.ollamaLocal.enabled;

  return (
    <div className="settings-page">
      <div className="settings-toolbar">
        <div className="settings-title">
          <SetupTabIcon />
          <div>
            <h1>Settings</h1>
            <span>Runtime configuration</span>
          </div>
          {dirty ? <span className="settings-dirty">Unsaved changes</span> : null}
          {savedMessage ? <span className="settings-saved">{savedMessage}</span> : null}
        </div>
        <div className="settings-actions">
          <button className="button" type="button" onClick={reseed} disabled={saving || testing}>Reseed</button>
          <button className="button is-primary" type="button" onClick={save} disabled={saving || testing || !dirty}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="settings-content">
        {activeSection === "overview" ? <Section id="overview" title="Overview">
          <SubGroup title="Operator">
            <FieldGrid>
              <Field label="Operator name" hint="How Butler should refer to you in chat. Leave blank for no name.">
                <input value={draft.overview.operatorName} placeholder="(none)" onChange={(event) => update((s) => { s.overview.operatorName = event.target.value; })} />
              </Field>
            </FieldGrid>
          </SubGroup>

          <SubGroup title="Provider routing">
            <FieldGrid>
              <Field label="Butler provider" hint="Which provider Butler should use for chat.">
                <select value={draft.overview.butlerProvider} onChange={(event) => update((s) => { s.overview.butlerProvider = event.target.value as never; })}>
                  {availableProviderOptions(payload.providerAvailability).map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </Field>
              <Field label="Codex worker provider" hint="Which provider the Codex worker should use for delegated work.">
                <select value={draft.overview.codexProvider} onChange={(event) => update((s) => { s.overview.codexProvider = event.target.value as never; })}>
                  {availableProviderOptions(payload.providerAvailability).map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </Field>
            </FieldGrid>
          </SubGroup>
        </Section> : null}

        {activeSection === "providers" ? <Section id="providers" title="Providers">
          <div className="settings-provider-tabs">
            <button className={`settings-provider-tab ${providerTab === "openai" ? "is-active" : ""}`} type="button" onClick={() => setProviderTab("openai")}>OpenAI / Codex</button>
            <button className={`settings-provider-tab ${providerTab === "ollamaLocal" ? "is-active" : ""}`} type="button" onClick={() => setProviderTab("ollamaLocal")}>Ollama Local</button>
            <button className={`settings-provider-tab ${providerTab === "ollama" ? "is-active" : ""}`} type="button" onClick={() => setProviderTab("ollama")}>Ollama Cloud</button>
            <button className={`settings-provider-tab ${providerTab === "opencode" ? "is-active" : ""}`} type="button" onClick={() => setProviderTab("opencode")}>OpenCode Go</button>
          </div>

          {providerTab === "openai" ? (
            <SubGroup title="OpenAI / Codex">
              {authError ? <div className="settings-auth-error">{authError}</div> : null}
              {authUrl ? (
                <div className="settings-auth-pending">
                  <span>Waiting for {authUrl.side === "butler" ? "Butler" : "Codex"} sign-in to complete…</span>
                  <a href={authUrl.url} target="_blank" rel="noopener noreferrer">Open auth page again</a>
                  <button className="button" type="button" onClick={() => void refreshAuth()}>I've signed in — refresh</button>
                </div>
              ) : null}
              <Field label="Butler auth" hint="Butler's OpenAI/Codex connection status.">
                <input readOnly value={formatAuthSummary(payload.openaiCodexAuth?.butler)} />
              </Field>
              {!payload.openaiCodexAuth?.butler.loggedIn ? (
                <div className="settings-auth-actions">
                  <button className="button is-primary" type="button" onClick={() => void startAuth("butler")} disabled={authPending !== null}>
                    {authPending === "butler" ? "Starting…" : "Sign in Butler with ChatGPT"}
                  </button>
                </div>
              ) : null}
              <Field label="Codex worker auth" hint="Codex worker's OpenAI/Codex connection status.">
                <input readOnly value={formatAuthSummary(payload.openaiCodexAuth?.codex)} />
              </Field>
              {!payload.openaiCodexAuth?.codex.loggedIn ? (
                <div className="settings-auth-actions">
                  <button className="button is-primary" type="button" onClick={() => void startAuth("codex")} disabled={authPending !== null}>
                    {authPending === "codex" ? "Starting…" : "Sign in Codex worker with ChatGPT"}
                  </button>
                </div>
              ) : null}
              <Field label="Web tools" hint="Web search/fetch is built into ChatGPT — no separate config needed.">
                <input readOnly value="Built into ChatGPT" />
              </Field>
            </SubGroup>
          ) : null}

          {providerTab === "ollamaLocal" ? (
            <SubGroup title={GROUP_LABELS["providers.ollamaLocal"]}>
              <ToggleGrid>
                <Toggle
                  label="Enabled"
                  hint="Use local Ollama models as a provider"
                  checked={draft.providers.ollamaLocal.enabled}
                  onChange={(next) => update((s) => { s.providers.ollamaLocal.enabled = next; })}
                />
              </ToggleGrid>
              <FieldGrid>
                <Field label="Base URL"><input readOnly value={draft.providers.ollamaLocal.baseUrl} /></Field>
                <Field label="Native host"><input readOnly value={draft.providers.ollamaLocal.nativeBaseUrl} /></Field>
              </FieldGrid>
              <div className="settings-subgroup-divider" />
              <div className="settings-subgroup-section-head"><h4>Local chat models</h4></div>
              <div className="settings-model-pills">
                {ollamaLocalModelsLoading ? <span className="settings-model-pills-hint">Loading…</span> : null}
                {ollamaLocalModelsError ? <div className="settings-auth-error">{ollamaLocalModelsError}</div> : null}
                {ollamaLocalModels?.map((model) => (
                  <span
                    key={model.id}
                    className="settings-model-pill"
                    title={model.contextWindow ? `${(model.contextWindow / 1024).toFixed(0)}k context` : undefined}
                  >
                    {model.id}
                    {model.contextWindow ? <span className="settings-model-pill-ctx">{(model.contextWindow / 1024).toFixed(0)}k</span> : null}
                  </span>
                ))}
                {ollamaLocalModels && ollamaLocalModels.length === 0 && !ollamaLocalModelsLoading ? <span className="settings-model-pills-hint">No local chat models found.</span> : null}
              </div>
              <div className="settings-subgroup-divider" />
              <div className="settings-subgroup-section-head"><h4>Pull model</h4></div>
              <div className="settings-model-pull">
                <input
                  value={ollamaPullModel}
                  placeholder="qwen3:8b"
                  disabled={ollamaPulling || !ollamaLocalPullEnabled}
                  onChange={(event) => {
                    setOllamaPullModel(event.target.value);
                    setOllamaPullError(null);
                    setOllamaPullWarning(false);
                    setOllamaPullDone(false);
                    setOllamaPullStatus(null);
                    setOllamaPullProgress(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && ollamaLocalPullEnabled) void pullOllamaLocalModel();
                  }}
                />
                <button className="button is-primary" type="button" disabled={ollamaPulling || !ollamaLocalPullEnabled || !ollamaPullModel.trim()} onClick={() => void pullOllamaLocalModel()}>
                  {ollamaPulling ? "Pulling..." : "Pull"}
                </button>
                {ollamaPulling ? (
                  <button className="button" type="button" onClick={() => ollamaPullAbortRef.current?.abort()}>
                    Cancel
                  </button>
                ) : null}
              </div>
              {(ollamaPullStatus || ollamaPullProgress || ollamaPullError || ollamaPullDone) ? (
                <div className={`settings-pull-status ${ollamaPullError ? "is-error" : ollamaPullWarning ? "is-warning" : ollamaPullDone ? "is-done" : ""}`}>
                  {ollamaPullStatus ? <span>{ollamaPullStatus}</span> : null}
                  {ollamaPullProgress && pullPercent !== null ? (
                    <>
                      <div className="settings-pull-progress" aria-label="Pull progress">
                        <span style={{ width: `${pullPercent}%` }} />
                      </div>
                      <span>{formatBytes(ollamaPullProgress.completed)} / {formatBytes(ollamaPullProgress.total)}</span>
                    </>
                  ) : null}
                  {ollamaPullError ? <span>{ollamaPullError}</span> : null}
                </div>
              ) : null}
            </SubGroup>
          ) : null}

          {providerTab === "ollama" ? (
            <SubGroup title={GROUP_LABELS["providers.ollamaCloud"]}>
              {payload.providerAvailability["ollama-cloud"].secretAvailable ? (
                <>
                  <ToggleGrid>
                    <Toggle
                      label="Enabled"
                      hint="Use Ollama Cloud as a model provider"
                      checked={draft.providers.ollamaCloud.enabled}
                      onChange={(next) => update((s) => { s.providers.ollamaCloud.enabled = next; })}
                    />
                  </ToggleGrid>
                  <Field label="Base URL"><input readOnly value={draft.providers.ollamaCloud.baseUrl} /></Field>
                  <div className="settings-subgroup-divider" />
                  <div className="settings-subgroup-section-head"><h4>Models</h4></div>
                  <div className="settings-model-pills">
                    {ollamaModelsLoading ? <span className="settings-model-pills-hint">Loading…</span> : null}
                    {ollamaModelsError ? <div className="settings-auth-error">{ollamaModelsError}</div> : null}
                    {ollamaModels?.map((model) => (
                      <span
                        key={model.id}
                        className="settings-model-pill"
                        title={model.contextWindow ? `${(model.contextWindow / 1024).toFixed(0)}k context` : undefined}
                      >
                        {model.id}
                        {model.contextWindow ? <span className="settings-model-pill-ctx">{(model.contextWindow / 1024).toFixed(0)}k</span> : null}
                      </span>
                    ))}
                    {ollamaModels && ollamaModels.length === 0 && !ollamaModelsLoading ? <span className="settings-model-pills-hint">No models found.</span> : null}
                  </div>

                  <div className="settings-subgroup-divider" />
                  <div className="settings-subgroup-section-head"><h4>Web tools (search &amp; fetch)</h4></div>
                  <ToggleGrid>
                    <Toggle label="Enabled" hint="Attach web_search/web_fetch to workers using Ollama models" checked={draft.providers.ollamaCloud.webTools.enabled} onChange={(next) => update((s) => { s.providers.ollamaCloud.webTools.enabled = next; })} />
                    <Toggle label="All Butler models" hint="Attach to all Butler models, not just Ollama" checked={draft.providers.ollamaCloud.webTools.forAllPiModels} onChange={(next) => update((s) => { s.providers.ollamaCloud.webTools.forAllPiModels = next; })} />
                  </ToggleGrid>
                  <FieldGrid>
                    <Field label="Base URL" wide><input readOnly value={draft.providers.ollamaCloud.webTools.baseUrl} /></Field>
                    <Field label="Max results"><input type="number" value={draft.providers.ollamaCloud.webTools.maxResults} onChange={(event) => update((s) => { s.providers.ollamaCloud.webTools.maxResults = Number(event.target.value); })} /></Field>
                    <Field label="Timeout (ms)"><input type="number" value={draft.providers.ollamaCloud.webTools.timeoutMs} onChange={(event) => update((s) => { s.providers.ollamaCloud.webTools.timeoutMs = Number(event.target.value); })} /></Field>
                    <Field label="Max content chars"><input type="number" value={draft.providers.ollamaCloud.webTools.maxContentChars} onChange={(event) => update((s) => { s.providers.ollamaCloud.webTools.maxContentChars = Number(event.target.value); })} /></Field>
                  </FieldGrid>
                </>
              ) : (
                <div className="settings-auth-error">Ollama Cloud is disabled. Set OLLAMA_API_KEY in .env and restart Manor to enable it.</div>
              )}
            </SubGroup>
          ) : null}

          {providerTab === "opencode" ? (
            <SubGroup title={GROUP_LABELS["providers.opencodeGo"]}>
              {payload.providerAvailability["opencode-go"].secretAvailable ? (
                <>
                  <ToggleGrid>
                    <Toggle
                      label="Enabled"
                      hint="Use OpenCode Go as a model provider"
                      checked={draft.providers.opencodeGo.enabled}
                      onChange={(next) => update((s) => { s.providers.opencodeGo.enabled = next; })}
                    />
                  </ToggleGrid>
                  <Field label="Base URL"><input readOnly value={draft.providers.opencodeGo.baseUrl} /></Field>
                  <div className="settings-subgroup-divider" />
                  <div className="settings-subgroup-section-head"><h4>Models</h4></div>
                  <div className="settings-model-pills">
                    {opencodeModelsLoading ? <span className="settings-model-pills-hint">Loading…</span> : null}
                    {opencodeModelsError ? <div className="settings-auth-error">{opencodeModelsError}</div> : null}
                    {opencodeModels?.map((model) => (
                      <span key={model.id} className="settings-model-pill" title="Served from OpenCode Go">
                        {model.id}
                      </span>
                    ))}
                    {opencodeModels && opencodeModels.length === 0 && !opencodeModelsLoading ? <span className="settings-model-pills-hint">No models found.</span> : null}
                  </div>

                  <div className="settings-subgroup-divider" />
                  <div className="settings-subgroup-section-head"><h4>Web tools (search &amp; fetch via Exa)</h4></div>
                  <ToggleGrid>
                    <Toggle label="Enabled" hint="Attach web_search/web_fetch to workers using OpenCode models" checked={draft.providers.opencodeGo.webTools.enabled} onChange={(next) => update((s) => { s.providers.opencodeGo.webTools.enabled = next; })} />
                  </ToggleGrid>
                  <FieldGrid>
                    <Field label="Max results"><input type="number" value={draft.providers.opencodeGo.webTools.maxResults} onChange={(event) => update((s) => { s.providers.opencodeGo.webTools.maxResults = Number(event.target.value); })} /></Field>
                    <Field label="Timeout (ms)"><input type="number" value={draft.providers.opencodeGo.webTools.timeoutMs} onChange={(event) => update((s) => { s.providers.opencodeGo.webTools.timeoutMs = Number(event.target.value); })} /></Field>
                    <Field label="Max content chars"><input type="number" value={draft.providers.opencodeGo.webTools.maxContentChars} onChange={(event) => update((s) => { s.providers.opencodeGo.webTools.maxContentChars = Number(event.target.value); })} /></Field>
                  </FieldGrid>
                </>
              ) : (
                <div className="settings-auth-error">OpenCode Go is disabled. Set OPENCODE_API_KEY in .env and restart Manor to enable it.</div>
              )}
            </SubGroup>
          ) : null}
        </Section> : null}

        {activeSection === "runtime" ? <Section id="runtime" title="Runtime">
          <SubGroup title={GROUP_LABELS.worker}>
            <FieldGrid>
              <Field label="Runtime" hint="Where new turns run">
                <select value={draft.worker.runtime} onChange={(event) => update((s) => { s.worker.runtime = event.target.value as never; })}>
                  <option value="auto">Auto</option>
                  <option value="openai">OpenAI / Codex CLI</option>
                  <option value="pi-rpc">Pi RPC</option>
                </select>
              </Field>
              <ModelSelectField
                label="Default model"
                value={draft.worker.defaultModel}
                models={workerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.worker.defaultModel = next; })}
              />
              <Field label="Default effort">
                <select value={draft.worker.defaultEffort ?? ""} onChange={(event) => update((s) => { s.worker.defaultEffort = (event.target.value || null) as never; })}>
                  <option value="">Model default</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">X-high</option>
                </select>
              </Field>
            </FieldGrid>
          </SubGroup>

          <SubGroup title={GROUP_LABELS.butler}>
            <FieldGrid>
              <ModelSelectField
                label="Default model"
                hint="Set before Butler delegates. Falls back to default if unset."
                value={draft.butler.defaultModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.butler.defaultModel = next; })}
              />
              <Field label="Thinking">
                <select value={draft.butler.defaultThinkingLevel} onChange={(event) => update((s) => { s.butler.defaultThinkingLevel = event.target.value as never; })}>
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">X-high</option>
                </select>
              </Field>
            </FieldGrid>
          </SubGroup>

          <SubGroup title={GROUP_LABELS.modelTasks}>
            <FieldGrid>
              <Field label="Runner">
                <select value={draft.modelTasks.runnerMode} onChange={(event) => update((s) => { s.modelTasks.runnerMode = event.target.value as never; })}>
                  <option value="auto">Auto</option>
                  <option value="codex">Codex</option>
                  <option value="pi">Pi inline</option>
                </select>
              </Field>
              <ModelSelectField
                label="Memory model"
                hint="Model used to synthesize memory"
                value={draft.modelTasks.memorySynthesisModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.modelTasks.memorySynthesisModel = next; })}
              />
              <ModelSelectField
                label="Title model"
                value={draft.modelTasks.sessionTitleModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.modelTasks.sessionTitleModel = next; })}
              />
              <Field label="Title timeout (ms)"><input type="number" value={draft.modelTasks.sessionTitleTimeoutMs} onChange={(event) => update((s) => { s.modelTasks.sessionTitleTimeoutMs = Number(event.target.value); })} /></Field>
              <ModelSelectField
                label="Routing model"
                hint="Classifies which worker should pick up a turn"
                value={draft.modelTasks.routingClassifierModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.modelTasks.routingClassifierModel = next; })}
              />
              <ModelSelectField
                label="Review model"
                hint="Reviews worker output"
                value={draft.modelTasks.workerReviewModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.modelTasks.workerReviewModel = next; })}
              />
              <ModelSelectField
                label="Promotion model"
                hint="Promotes memory candidates"
                value={draft.modelTasks.memoryPromotionModel}
                models={butlerModels}
                available={payload.providerAvailability}
                onChange={(next) => update((s) => { s.modelTasks.memoryPromotionModel = next; })}
              />
            </FieldGrid>
          </SubGroup>
        </Section> : null}

        {activeSection === "memory" ? <Section id="memory" title="Memory">
          <SubGroup title={GROUP_LABELS.memory}>
            <ToggleGrid>
              <Toggle label="Synthesis" hint="Run synthesis passes" checked={draft.memory.synthesisEnabled} onChange={(next) => update((s) => { s.memory.synthesisEnabled = next; })} />
              <Toggle label="Auto promote" checked={draft.memory.promotionAutoResolve} onChange={(next) => update((s) => { s.memory.promotionAutoResolve = next; })} />
              <Toggle label="Semantic edges" checked={draft.memory.semanticEdgeReviewEnabled} onChange={(next) => update((s) => { s.memory.semanticEdgeReviewEnabled = next; })} />
            </ToggleGrid>
            <FieldGrid>
              <Field label="Synthesis effort">
                <select value={draft.memory.synthesisEffort ?? ""} onChange={(event) => update((s) => { s.memory.synthesisEffort = (event.target.value || null) as never; })}>
                  <option value="">Default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
              <Field label="Timeout (ms)"><input type="number" value={draft.memory.synthesisTimeoutMs} onChange={(event) => update((s) => { s.memory.synthesisTimeoutMs = Number(event.target.value); })} /></Field>
              <Field label="Max input chars"><input type="number" value={draft.memory.synthesisMaxInputChars} onChange={(event) => update((s) => { s.memory.synthesisMaxInputChars = Number(event.target.value); })} /></Field>
              <Field label="Candidates per run"><input type="number" value={draft.memory.synthesisMaxCandidatesPerRun} onChange={(event) => update((s) => { s.memory.synthesisMaxCandidatesPerRun = Number(event.target.value); })} /></Field>
              <Field label="Promotion batch"><input type="number" value={draft.memory.promotionBatchSize} onChange={(event) => update((s) => { s.memory.promotionBatchSize = Number(event.target.value); })} /></Field>
              <Field label="Promotion max batches"><input type="number" value={draft.memory.promotionMaxBatchesPerRun} onChange={(event) => update((s) => { s.memory.promotionMaxBatchesPerRun = Number(event.target.value); })} /></Field>
              <Field label="Promotion interval (ms)"><input type="number" value={draft.memory.promotionIntervalMs} onChange={(event) => update((s) => { s.memory.promotionIntervalMs = Number(event.target.value); })} /></Field>
              <Field label="Semantic batch"><input type="number" value={draft.memory.semanticEdgeReviewBatchSize} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewBatchSize = Number(event.target.value); })} /></Field>
              <Field label="Semantic interval (ms)"><input type="number" value={draft.memory.semanticEdgeReviewIntervalMs} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewIntervalMs = Number(event.target.value); })} /></Field>
            </FieldGrid>
          </SubGroup>

          <SubGroup title={GROUP_LABELS.embeddings}
            actions={<button className="button is-small" type="button" onClick={() => void restoreGroup("embeddings")} disabled={saving || testing}>Restore defaults</button>}
          >
            <ToggleGrid>
              <Toggle label="Enabled" hint="Vector backfill" checked={draft.embeddings.enabled} onChange={(next) => update((s) => { s.embeddings.enabled = next; })} />
            </ToggleGrid>
            <FieldGrid>
              <Field label="Host" hint="Any Ollama-compatible /api/embed endpoint (local or remote)"><input value={draft.embeddings.host} onChange={(event) => update((s) => { s.embeddings.host = event.target.value; })} /></Field>
              <Field label="Model"><input value={draft.embeddings.model} onChange={(event) => update((s) => { s.embeddings.model = event.target.value; })} /></Field>
              <Field label="Timeout (ms)"><input type="number" value={draft.embeddings.timeoutMs} onChange={(event) => update((s) => { s.embeddings.timeoutMs = Number(event.target.value); })} /></Field>
              <Field label="Backfill batch size"><input type="number" value={draft.embeddings.backfillBatchSize} onChange={(event) => update((s) => { s.embeddings.backfillBatchSize = Number(event.target.value); })} /></Field>
            </FieldGrid>
          </SubGroup>
        </Section> : null}

        {activeSection === "diagnostics" ? <Section
          id="diagnostics"
          title="Diagnostics"
          actions={
            <button
              className="button is-primary"
              type="button"
              onClick={() => void validateAll()}
              disabled={saving || testing}
            >
              {validatingAll ? "Testing all..." : "Test all"}
            </button>
          }
        >
          <SubGroup title="Connection tests">
            <div className="settings-diag-summary">
              <span className="settings-diag-count is-ok">{okCount} healthy</span>
              {failingCount > 0 ? <span className="settings-diag-count is-failed">{failingCount} failing</span> : null}
              {unconfiguredCount > 0 ? <span className="settings-diag-count is-muted">{unconfiguredCount} not configured</span> : null}
            </div>
            <div className="settings-diag-rows">
              {VALIDATION_TARGETS.map((target) => {
                const check = payload.validation[target];
                const lastChecked = check.lastCheckedAt
                  ? new Date(check.lastCheckedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
                  : null;
                return (
                  <div className={`settings-diag-row is-${check.status}`} key={target}>
                    <div className="settings-diag-row-head">
                      <strong>{VALIDATION_LABELS[target]}</strong>
                      <StatusPill status={check.status} />
                    </div>
                    <span className="settings-diag-row-message">
                      {check.message ?? "Not checked yet"}
                    </span>
                    {lastChecked ? <span className="settings-diag-row-time">Last checked {lastChecked}</span> : null}
                    <button className="button is-small" type="button" onClick={() => void validate(target)} disabled={saving || testing}>
                      {validating === target ? "Testing..." : "Test"}
                    </button>
                  </div>
                );
              })}
            </div>
          </SubGroup>
        </Section> : null}

        {errorMessage ? <div className="settings-error"><WarningIcon />{errorMessage}</div> : null}
      </div>
    </div>
  );
}
