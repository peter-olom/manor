import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { getJson, patchJson, postJson } from "./api";
import { SetupTabIcon, WarningIcon } from "./icons";
import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsSecretSource,
  SettingsValidationKey,
  SettingsValidationMap
} from "../shared/settings";

type ModelOption = { id: string; label: string; provider: string | null };
type SettingsResponse = {
  settings: ManorSettings;
  provenance: ManorSettingsProvenance;
  availableModels: {
    butler: ModelOption[];
    codex: ModelOption[];
    piRpc: ModelOption[];
    worker: { availableModels: ModelOption[] };
  };
  validation: SettingsValidationMap;
};

const GROUP_LABELS: Record<SettingsGroupKey, string> = {
  "providers.ollamaCloud": "Ollama Cloud",
  "providers.ollamaWebTools": "Web tools",
  worker: "Worker",
  butler: "Butler",
  modelTasks: "Model tasks",
  memory: "Memory",
  embeddings: "Embeddings"
};

function cloneSettings(settings: ManorSettings): ManorSettings {
  return JSON.parse(JSON.stringify(settings)) as ManorSettings;
}

function modelValue(option: ModelOption): string {
  return option.provider ? `${option.provider}/${option.id}` : option.id;
}

function secretLabel(source: SettingsSecretSource): string {
  if (source.type === "env") return `env:${source.name}`;
  if (source.type === "file") return `file-env:${source.pathEnv}`;
  return `asiri:${source.workspace}:${source.path}`;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`settings-status is-${status}`}>{status.replace(/_/g, " ")}</span>;
}

function Field({
  label,
  children,
  hint
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function Section({
  title,
  provenance,
  children
}: {
  title: string;
  provenance?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <header className="settings-section-head">
        <h2>{title}</h2>
        {provenance ? <span className="settings-provenance">{provenance}</span> : null}
      </header>
      <div className="settings-grid">{children}</div>
    </section>
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

export function SettingsDashboard() {
  const [payload, setPayload] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<ManorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState<SettingsValidationKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const workerModels = useMemo(() => payload?.availableModels.worker.availableModels.map(modelValue) ?? [], [payload]);
  const butlerModels = useMemo(() => payload?.availableModels.butler.map(modelValue) ?? [], [payload]);

  const load = useCallback(async () => {
    const next = await getJson<SettingsResponse>("/api/settings");
    setPayload(next);
    setDraft(cloneSettings(next.settings));
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [load]);

  const update = useCallback((mutate: (settings: ManorSettings) => void) => {
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

  async function validate(target: SettingsValidationKey) {
    setValidating(target);
    setMessage(null);
    try {
      const next = await postJson<SettingsResponse>("/api/settings/validate", { target });
      setPayload(next);
      setDraft(cloneSettings(next.settings));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setValidating(null);
    }
  }

  if (!draft || !payload) {
    return (
      <div className="settings-page">
        <div className="settings-empty">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-toolbar">
        <div className="settings-title">
          <SetupTabIcon />
          <h1>Settings</h1>
        </div>
        <div className="settings-actions">
          {message ? <span className="settings-message">{message}</span> : null}
          <button className="button" type="button" onClick={reseed} disabled={saving}>Reseed</button>
          <button className="button is-primary" type="button" onClick={save} disabled={saving}>{saving ? "Saving" : "Save"}</button>
        </div>
      </div>

      <div className="settings-content">
        <Section title={GROUP_LABELS["providers.ollamaCloud"]} provenance={payload.provenance["providers.ollamaCloud"]}>
          <Field label="Enabled"><input type="checkbox" checked={draft.providers.ollamaCloud.enabled} onChange={(event) => update((s) => { s.providers.ollamaCloud.enabled = event.target.checked; })} /></Field>
          <Field label="Provider ID"><input value={draft.providers.ollamaCloud.providerId} onChange={(event) => update((s) => { s.providers.ollamaCloud.providerId = event.target.value; })} /></Field>
          <Field label="Provider name"><input value={draft.providers.ollamaCloud.providerName} onChange={(event) => update((s) => { s.providers.ollamaCloud.providerName = event.target.value; })} /></Field>
          <Field label="Base URL"><input value={draft.providers.ollamaCloud.baseUrl} onChange={(event) => update((s) => { s.providers.ollamaCloud.baseUrl = event.target.value; })} /></Field>
          <Field label="API"><input value={draft.providers.ollamaCloud.api} onChange={(event) => update((s) => { s.providers.ollamaCloud.api = event.target.value; })} /></Field>
          <Field label="Models"><input value={draft.providers.ollamaCloud.models.join(",")} onChange={(event) => update((s) => { s.providers.ollamaCloud.models = event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean); })} /></Field>
          <Field label="Context window"><input type="number" value={draft.providers.ollamaCloud.contextWindow} onChange={(event) => update((s) => { s.providers.ollamaCloud.contextWindow = Number(event.target.value); })} /></Field>
          <Field label="Max tokens"><input type="number" value={draft.providers.ollamaCloud.maxTokens} onChange={(event) => update((s) => { s.providers.ollamaCloud.maxTokens = Number(event.target.value); })} /></Field>
          <Field label="Reasoning"><input type="checkbox" checked={draft.providers.ollamaCloud.reasoning} onChange={(event) => update((s) => { s.providers.ollamaCloud.reasoning = event.target.checked; })} /></Field>
          <Field label="Developer role"><input type="checkbox" checked={draft.providers.ollamaCloud.supportsDeveloperRole} onChange={(event) => update((s) => { s.providers.ollamaCloud.supportsDeveloperRole = event.target.checked; })} /></Field>
          <Field label="Reasoning effort"><input type="checkbox" checked={draft.providers.ollamaCloud.supportsReasoningEffort} onChange={(event) => update((s) => { s.providers.ollamaCloud.supportsReasoningEffort = event.target.checked; })} /></Field>
          <Field label={`API key source (${secretLabel(draft.providers.ollamaCloud.apiKeySource)})`}><SecretSourceEditor value={draft.providers.ollamaCloud.apiKeySource} onChange={(value) => update((s) => { s.providers.ollamaCloud.apiKeySource = value; })} /></Field>
        </Section>

        <Section title={GROUP_LABELS.worker} provenance={payload.provenance.worker}>
          <Field label="Runtime"><select value={draft.worker.runtime} onChange={(event) => update((s) => { s.worker.runtime = event.target.value as never; })}><option value="auto">Auto</option><option value="codex">Codex</option><option value="pi-rpc">Pi RPC</option></select></Field>
          <Field label="Default model"><input list="settings-worker-models" value={draft.worker.defaultModel ?? ""} onChange={(event) => update((s) => { s.worker.defaultModel = event.target.value || null; })} /></Field>
          <Field label="Default effort"><select value={draft.worker.defaultEffort ?? ""} onChange={(event) => update((s) => { s.worker.defaultEffort = (event.target.value || null) as never; })}><option value="">Model default</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">X-high</option></select></Field>
          <datalist id="settings-worker-models">{workerModels.map((model) => <option key={model} value={model} />)}</datalist>
        </Section>

        <Section title={GROUP_LABELS.butler} provenance={payload.provenance.butler}>
          <Field label="Default model"><input list="settings-butler-models" value={draft.butler.defaultModel ?? ""} onChange={(event) => update((s) => { s.butler.defaultModel = event.target.value || null; })} /></Field>
          <Field label="Thinking"><select value={draft.butler.defaultThinkingLevel} onChange={(event) => update((s) => { s.butler.defaultThinkingLevel = event.target.value as never; })}><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">X-high</option></select></Field>
          <datalist id="settings-butler-models">{butlerModels.map((model) => <option key={model} value={model} />)}</datalist>
        </Section>

        <Section title={GROUP_LABELS.modelTasks} provenance={payload.provenance.modelTasks}>
          <Field label="Runner"><select value={draft.modelTasks.runnerMode} onChange={(event) => update((s) => { s.modelTasks.runnerMode = event.target.value as never; })}><option value="auto">Auto</option><option value="codex">Codex</option><option value="pi">Pi inline</option></select></Field>
          <Field label="Memory model"><input value={draft.modelTasks.memorySynthesisModel ?? ""} onChange={(event) => update((s) => { s.modelTasks.memorySynthesisModel = event.target.value || null; })} /></Field>
          <Field label="Title model"><input value={draft.modelTasks.sessionTitleModel ?? ""} onChange={(event) => update((s) => { s.modelTasks.sessionTitleModel = event.target.value || null; })} /></Field>
          <Field label="Title timeout"><input type="number" value={draft.modelTasks.sessionTitleTimeoutMs} onChange={(event) => update((s) => { s.modelTasks.sessionTitleTimeoutMs = Number(event.target.value); })} /></Field>
          <Field label="Routing model"><input value={draft.modelTasks.routingClassifierModel ?? ""} onChange={(event) => update((s) => { s.modelTasks.routingClassifierModel = event.target.value || null; })} /></Field>
          <Field label="Review model"><input value={draft.modelTasks.workerReviewModel ?? ""} onChange={(event) => update((s) => { s.modelTasks.workerReviewModel = event.target.value || null; })} /></Field>
          <Field label="Promotion model"><input value={draft.modelTasks.memoryPromotionModel ?? ""} onChange={(event) => update((s) => { s.modelTasks.memoryPromotionModel = event.target.value || null; })} /></Field>
        </Section>

        <Section title={GROUP_LABELS["providers.ollamaWebTools"]} provenance={payload.provenance["providers.ollamaWebTools"]}>
          <Field label="Enabled"><input type="checkbox" checked={draft.providers.ollamaWebTools.enabled} onChange={(event) => update((s) => { s.providers.ollamaWebTools.enabled = event.target.checked; })} /></Field>
          <Field label="Base URL"><input value={draft.providers.ollamaWebTools.baseUrl} onChange={(event) => update((s) => { s.providers.ollamaWebTools.baseUrl = event.target.value; })} /></Field>
          <Field label="Max results"><input type="number" value={draft.providers.ollamaWebTools.maxResults} onChange={(event) => update((s) => { s.providers.ollamaWebTools.maxResults = Number(event.target.value); })} /></Field>
          <Field label="Timeout"><input type="number" value={draft.providers.ollamaWebTools.timeoutMs} onChange={(event) => update((s) => { s.providers.ollamaWebTools.timeoutMs = Number(event.target.value); })} /></Field>
          <Field label="Max content chars"><input type="number" value={draft.providers.ollamaWebTools.maxContentChars} onChange={(event) => update((s) => { s.providers.ollamaWebTools.maxContentChars = Number(event.target.value); })} /></Field>
          <Field label="All Pi models"><input type="checkbox" checked={draft.providers.ollamaWebTools.forAllPiModels} onChange={(event) => update((s) => { s.providers.ollamaWebTools.forAllPiModels = event.target.checked; })} /></Field>
          <Field label={`API key source (${secretLabel(draft.providers.ollamaWebTools.apiKeySource)})`}><SecretSourceEditor value={draft.providers.ollamaWebTools.apiKeySource} onChange={(value) => update((s) => { s.providers.ollamaWebTools.apiKeySource = value; })} /></Field>
        </Section>

        <Section title={GROUP_LABELS.memory} provenance={payload.provenance.memory}>
          <Field label="Synthesis"><input type="checkbox" checked={draft.memory.synthesisEnabled} onChange={(event) => update((s) => { s.memory.synthesisEnabled = event.target.checked; })} /></Field>
          <Field label="Synthesis effort"><select value={draft.memory.synthesisEffort ?? ""} onChange={(event) => update((s) => { s.memory.synthesisEffort = (event.target.value || null) as never; })}><option value="">Default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
          <Field label="Timeout"><input type="number" value={draft.memory.synthesisTimeoutMs} onChange={(event) => update((s) => { s.memory.synthesisTimeoutMs = Number(event.target.value); })} /></Field>
          <Field label="Max input chars"><input type="number" value={draft.memory.synthesisMaxInputChars} onChange={(event) => update((s) => { s.memory.synthesisMaxInputChars = Number(event.target.value); })} /></Field>
          <Field label="Candidates"><input type="number" value={draft.memory.synthesisMaxCandidatesPerRun} onChange={(event) => update((s) => { s.memory.synthesisMaxCandidatesPerRun = Number(event.target.value); })} /></Field>
          <Field label="Auto promote"><input type="checkbox" checked={draft.memory.promotionAutoResolve} onChange={(event) => update((s) => { s.memory.promotionAutoResolve = event.target.checked; })} /></Field>
          <Field label="Promotion batch"><input type="number" value={draft.memory.promotionBatchSize} onChange={(event) => update((s) => { s.memory.promotionBatchSize = Number(event.target.value); })} /></Field>
          <Field label="Promotion max batches"><input type="number" value={draft.memory.promotionMaxBatchesPerRun} onChange={(event) => update((s) => { s.memory.promotionMaxBatchesPerRun = Number(event.target.value); })} /></Field>
          <Field label="Promotion interval"><input type="number" value={draft.memory.promotionIntervalMs} onChange={(event) => update((s) => { s.memory.promotionIntervalMs = Number(event.target.value); })} /></Field>
          <Field label="Semantic edges"><input type="checkbox" checked={draft.memory.semanticEdgeReviewEnabled} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewEnabled = event.target.checked; })} /></Field>
          <Field label="Semantic batch"><input type="number" value={draft.memory.semanticEdgeReviewBatchSize} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewBatchSize = Number(event.target.value); })} /></Field>
          <Field label="Semantic interval"><input type="number" value={draft.memory.semanticEdgeReviewIntervalMs} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewIntervalMs = Number(event.target.value); })} /></Field>
        </Section>

        <Section title={GROUP_LABELS.embeddings} provenance={payload.provenance.embeddings}>
          <Field label="Enabled"><input type="checkbox" checked={draft.embeddings.enabled} onChange={(event) => update((s) => { s.embeddings.enabled = event.target.checked; })} /></Field>
          <Field label="Host"><input value={draft.embeddings.host} onChange={(event) => update((s) => { s.embeddings.host = event.target.value; })} /></Field>
          <Field label="Model"><input value={draft.embeddings.model} onChange={(event) => update((s) => { s.embeddings.model = event.target.value; })} /></Field>
          <Field label="Timeout"><input type="number" value={draft.embeddings.timeoutMs} onChange={(event) => update((s) => { s.embeddings.timeoutMs = Number(event.target.value); })} /></Field>
          <Field label="Batch size"><input type="number" value={draft.embeddings.backfillBatchSize} onChange={(event) => update((s) => { s.embeddings.backfillBatchSize = Number(event.target.value); })} /></Field>
        </Section>

        <section className="settings-section">
          <header className="settings-section-head"><h2>Diagnostics</h2></header>
          <div className="settings-diagnostics">
            {(["codex", "piRpc", "ollamaCloud", "ollamaWebSearch", "ollamaWebFetch", "memoryEmbeddings"] as SettingsValidationKey[]).map((target) => {
              const check = payload.validation[target];
              return (
                <div className="settings-diagnostic" key={target}>
                  <div><strong>{target}</strong><StatusPill status={check.status} /></div>
                  <span>{check.message ?? "Not checked"}</span>
                  <button className="button" type="button" onClick={() => void validate(target)} disabled={Boolean(validating)}>{validating === target ? "Testing" : "Test"}</button>
                </div>
              );
            })}
          </div>
        </section>
        {message && message !== "Saved" && message !== "Reseed complete" ? <div className="settings-error"><WarningIcon />{message}</div> : null}
      </div>
    </div>
  );
}
