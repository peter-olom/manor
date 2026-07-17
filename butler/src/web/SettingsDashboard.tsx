import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { getJson, patchJson, postJson } from "./api";
import { ModelPicker, modelOptionValue, type ModelPickerGroup, type ModelPickerOption } from "./ModelPicker";
import { WarningIcon } from "./icons";
import { SkillsDashboard } from "./SkillsDashboard";
import { RuntimeEgressDashboard } from "./RuntimeEgressDashboard";
import { UsageDashboard } from "./UsageDashboard";
import {
  workerHarnessLabel,
  workerModelForRoute,
  workerModelForSelection,
  workerModelPickerOption,
  workerModelSelectionId
} from "./worker-route";
import type {
  ManorSettings,
  ManorSettingsProvenance,
  SettingsGroupKey,
  SettingsProviderAvailabilityMap,
  SettingsSecretSource,
  SettingsValidationKey,
  SettingsValidationMap,
  SettingsWorkerHarness
} from "../shared/settings";
import type { ActivityWatchdogDiagnostics, ActivityWatchdogSnapshot } from "../shared/activity-watchdog";

type ModelOption = {
  id: string;
  label: string;
  provider: string | null;
  harness?: SettingsWorkerHarness | null;
  inputCapabilities?: {
    image: "supported" | "unsupported" | "unknown";
    source: "override" | "provider" | "manifest" | "unknown";
  };
};
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
    modelTasks: ModelOption[];
    vision: ModelOption[];
    worker: { harness: SettingsWorkerHarness | null; model: string | null; availableModels: ModelOption[] };
  };
  providerAvailability: SettingsProviderAvailabilityMap;
  modelTaskProviderAvailability: SettingsProviderAvailabilityMap;
  openaiCodexAuth?: { butler: AuthStatusView; codex: AuthStatusView };
  validation: SettingsValidationMap;
};

const GROUP_LABELS: Record<SettingsGroupKey, string> = {
  overview: "Operator",
  "providers.ollamaLocal": "Ollama Local",
  "providers.ollamaCloud": "Ollama Cloud",
  "providers.opencodeGo": "OpenCode Go",
  worker: "Worker",
  butler: "Butler",
  vision: "Vision assistance",
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
  codex: "Codex app-server harness",
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

export type SettingsSectionId = "runtime" | "network" | "providers" | "usage" | "skills" | "memory" | "diagnostics";
export const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; description: string }[] = [
  { id: "runtime", label: "Runtime", description: "Operator, Worker, vision, and titles" },
  { id: "network", label: "Network", description: "Runtime internet access" },
  { id: "providers", label: "Providers", description: "Model and tool access" },
  { id: "usage", label: "Usage", description: "Model tokens and estimated spend" },
  { id: "skills", label: "Skills", description: "Browse, install, and edit agent skills" },
  { id: "memory", label: "Memory", description: "Models, synthesis, and embeddings" },
  { id: "diagnostics", label: "Diagnostics", description: "Connection tests" }
];

const SECTION_HELP: Record<SettingsSectionId, string> = {
  network: "Allow or remove trusted internet hosts for the shared Butler and Worker runtime.",
  providers: "Configure the model providers (OpenAI/Codex, Ollama Local, Ollama Cloud, OpenCode Go) and web tools Butler can use.",
  usage: "Review recorded model tokens, known costs, and subscription usage across Butler and Workers.",
  skills: "Browse and manage the skills available to Butler Pi, Worker Pi, and Worker Codex.",
  runtime: "Set operator and Worker defaults, choose the shared vision companion, and configure session titles.",
  memory: "Choose the models and behavior used to synthesize, promote, and connect memory.",
  diagnostics: "Run connection checks for the services Butler depends on."
};

function cloneSettings(settings: ManorSettings): ManorSettings {
  return JSON.parse(JSON.stringify(settings)) as ManorSettings;
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
      {hint ? <small>{hint}</small> : null}
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

const FALLBACK_OPERATOR_TIMEZONES: readonly string[] = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Moscow",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland"
];

const OPERATOR_TIMEZONE_SUGGESTIONS: readonly string[] = (() => {
  try {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
    const zones = supportedValuesOf?.("timeZone") ?? [];
    if (zones.length > 0) return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
  } catch {
    // Older browsers use the concise fallback list below.
  }
  return [...FALLBACK_OPERATOR_TIMEZONES];
})();

function timezoneShortOffset(zone: string): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    const value = part?.value ?? "";
    if (!value) return null;
    return value === "GMT" || value === "GMT+0" || value === "GMT-0" ? "UTC" : value.replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
}

const OPERATOR_TIMEZONE_OPTIONS: { zone: string; label: string }[] = OPERATOR_TIMEZONE_SUGGESTIONS.map((zone) => {
  const offset = timezoneShortOffset(zone);
  return { zone, label: offset ? `${zone} (${offset})` : zone };
});

function timezonePreview(zone: string | null | undefined): string {
  const trimmed = (zone ?? "").trim();
  if (!trimmed) return "Uses UTC when blank. Changing it updates existing daily schedules.";
  const offset = timezoneShortOffset(trimmed);
  return offset
    ? `Used for schedules, reminders, and displayed times. Current offset: ${offset}. Changing it updates existing daily schedules.`
    : "Choose a valid timezone, for example Africa/Lagos.";
}

export function timezoneInputIsValid(zone: string | null | undefined): boolean {
  const trimmed = (zone ?? "").trim();
  return !trimmed || timezoneShortOffset(trimmed) !== null;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function resolveProviderSettingsParam(provider: string | null, aliases: Record<string, string>): string | null {
  if (!provider) return null;
  if (aliases[provider]) return aliases[provider];
  if (provider === "ollama-local") return "ollama-local";
  if (provider === "ollama-cloud") return "ollama";
  if (provider === "opencode-go") return "opencode";
  if (provider === "openai" || provider === "openai-codex") return "openai";
  return null;
}

function matchingModels(value: string, models: ModelOption[]): ModelOption[] {
  return models.filter((model) => {
    const optionValue = modelOptionValue(model as ModelPickerOption);
    if (model.id === value || optionValue === value) return true;
    return !value.includes("/") && optionValue.endsWith(`/${value}`);
  });
}

export function resolveSettingsModelValue(value: string | null, models: ModelOption[]): string | null {
  if (!value) return null;
  const matches = matchingModels(value, models);
  return matches.length === 1 ? modelOptionValue(matches[0] as ModelPickerOption) : null;
}

function modelProvider(value: string | null, models: ModelOption[]): string | null {
  if (!value) return null;
  const resolved = resolveSettingsModelValue(value, models);
  const match = resolved ? models.find((model) => modelOptionValue(model as ModelPickerOption) === resolved) : null;
  if (match?.provider) return match.provider;
  return value.includes("/") ? value.slice(0, value.indexOf("/")) : null;
}

function taskRouteHint(value: string | null, models: ModelOption[], automaticHint: string): string {
  const provider = modelProvider(value, models);
  return provider ? `Manor runs this with ${providerLabel(provider)} automatically.` : automaticHint;
}

function seconds(milliseconds: number): number {
  return Math.max(1, Math.round(milliseconds / 1000));
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
  disabled,
  automaticLabel = "Automatic",
  providerSettingsTabs = {}
}: {
  label: string;
  hint?: string;
  value: string | null;
  models: ModelOption[];
  available: SettingsProviderAvailabilityMap | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  automaticLabel?: string;
  providerSettingsTabs?: Record<string, string>;
}) {
  const filtered = useMemo(
    () => available
      ? models.filter((model) => {
          const entry = available[(model.provider ?? "openai-codex") as ProviderKey];
          return Boolean(entry?.secretAvailable && entry.enabled);
        })
      : models,
    [available, models]
  );
  const resolvedValue = resolveSettingsModelValue(value, filtered);
  const selectedValue = resolvedValue ?? value;
  const selectedIsAvailable = Boolean(resolvedValue);
  const unavailableProvider = value?.includes("/") ? value.slice(0, value.indexOf("/")) : null;
  const unavailableReason = unavailableProvider
    ? available?.[unavailableProvider as ProviderKey]?.reason ?? null
    : null;
  const unavailableProviderTab = resolveProviderSettingsParam(unavailableProvider, providerSettingsTabs);
  const pickerOptions = useMemo<ModelOption[]>(
    () => value && !selectedIsAvailable
      ? [{ id: value, label: `Unavailable · ${value}`, provider: unavailableProvider, disabled: true, disabledReason: unavailableReason } as ModelPickerOption, ...filtered]
      : filtered,
    [filtered, selectedIsAvailable, unavailableProvider, unavailableReason, value]
  );
  const groups: ModelPickerGroup[] = useMemo(
    () => groupModelsByProvider(pickerOptions).map((group) => ({
      provider: group.provider,
      label: providerLabel(group.provider),
      options: group.options as ModelPickerOption[]
    })),
    [pickerOptions]
  );
  const options = pickerOptions as ModelPickerOption[];
  return (
    <Field label={label} hint={hint}>
      <ModelPicker
        label={label}
        value={selectedValue}
        options={options}
        groups={groups}
        placeholder={automaticLabel}
        disabled={disabled || (filtered.length === 0 && !value)}
        disabledPlaceholder="No authenticated models"
        allowClear
        clearLabel={`Use ${automaticLabel.toLowerCase()}`}
        onChange={onChange}
      />
      {value && !selectedIsAvailable ? (
        <span className="settings-field-warning" role="status">
          This saved model is unavailable. {unavailableReason ?? "Reconnect its provider or choose another model."}{" "}
          <a href={unavailableProviderTab ? `/settings/providers?provider=${unavailableProviderTab}` : "/settings/providers"}>Open provider settings</a>
        </span>
      ) : null}
    </Field>
  );
}

export function resolveWorkerSettingsSelection(selectionId: string | null, models: ModelOption[]): { defaultModel: string | null; defaultHarness: SettingsWorkerHarness | null } | null {
  if (!selectionId) return { defaultModel: null, defaultHarness: null };
  const selected = workerModelForSelection(models, selectionId);
  return selected ? { defaultModel: selected.id, defaultHarness: selected.harness ?? null } : null;
}

function WorkerModelSelectField({
  value,
  harness,
  models,
  onChange
}: {
  value: string | null;
  harness: SettingsWorkerHarness | null;
  models: ModelOption[];
  onChange: (model: string | null, harness: SettingsWorkerHarness | null) => void;
}) {
  const selected = workerModelForRoute(models, value, harness);
  const unavailableSelectionId = value ? `unavailable|${encodeURIComponent(harness ?? "")}|${encodeURIComponent(value)}` : null;
  const pickerOptions = useMemo<ModelPickerOption[]>(() => {
    const available = models.map(workerModelPickerOption);
    if (!value || selected) return available;
    return [{
      id: value,
      selectionId: unavailableSelectionId ?? value,
      label: `Unavailable · ${value}`,
      provider: value.includes("/") ? value.slice(0, value.indexOf("/")) : null,
      hint: `${workerHarnessLabel(harness)} harness`,
      disabled: true,
      disabledReason: "Reconnect its provider or choose another Worker route."
    }, ...available];
  }, [harness, models, selected, unavailableSelectionId, value]);
  const groups = useMemo<ModelPickerGroup[]>(
    () => groupModelsByProvider(pickerOptions).map((group) => ({
      provider: group.provider,
      label: providerLabel(group.provider),
      options: group.options
    })),
    [pickerOptions]
  );
  const selectedValue = selected ? workerModelSelectionId(selected) : unavailableSelectionId;

  return (
    <Field label="Default worker model" hint="Used for the first delegation when more than one Worker route is available. The selection includes harness, provider, and model.">
      <ModelPicker
        label="Default worker model"
        value={selectedValue}
        options={pickerOptions}
        groups={groups}
        placeholder="Automatic"
        disabled={models.length === 0 && !value}
        disabledPlaceholder="No authenticated models"
        allowClear
        clearLabel="Use automatic selection"
        onChange={(selectionId) => {
          const next = resolveWorkerSettingsSelection(selectionId, models);
          if (next) onChange(next.defaultModel, next.defaultHarness);
        }}
      />
      {value && !selected ? (
        <span className="settings-field-warning" role="status">
          This saved Worker route is unavailable. Reconnect its provider or choose another route. <a href="/settings/providers">Open provider settings</a>
        </span>
      ) : null}
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

function watchdogCadence(intervalMs: number): string {
  return intervalMs >= 1_000 ? `${intervalMs / 1_000}s` : `${intervalMs}ms`;
}

function watchdogTarget(watchdog: ActivityWatchdogSnapshot): string {
  const target = watchdog.target ?? watchdog.id;
  return target.length > 22 ? `${target.slice(0, 18)}…` : target;
}

export function SettingsDashboard({ active, activeSection, pairId }: { active: boolean; activeSection: SettingsSectionId; pairId: string | null }) {
  const [payload, setPayload] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<ManorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState<SettingsValidationKey | null>(null);
  const [validatingAll, setValidatingAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [watchdogDiagnostics, setWatchdogDiagnostics] = useState<ActivityWatchdogDiagnostics | null>(null);
  const [watchdogError, setWatchdogError] = useState<string | null>(null);
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

  const taskModels = useMemo(() => payload?.availableModels.modelTasks ?? [], [payload]);
  const visionModels = useMemo(() => payload?.availableModels.vision ?? [], [payload]);
  const workerModels = useMemo(() => payload?.availableModels.worker.availableModels ?? [], [payload]);

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
    if (!active || activeSection !== "diagnostics" || !pairId) {
      setWatchdogDiagnostics(null);
      setWatchdogError(null);
      return;
    }
    setWatchdogDiagnostics(null);
    setWatchdogError(null);
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await getJson<ActivityWatchdogDiagnostics>(`/api/pairs/${encodeURIComponent(pairId)}/activity-watchdogs`);
        if (!disposed) {
          setWatchdogDiagnostics(next);
          setWatchdogError(null);
        }
      } catch (error) {
        if (!disposed) {
          setWatchdogDiagnostics(null);
          setWatchdogError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, activeSection, pairId]);

  useEffect(() => {
    if (typeof window === "undefined" || !active || activeSection !== "providers") return;
    const url = new URL(window.location.href);
    url.searchParams.set("provider", providerTab === "ollamaLocal" ? "ollama-local" : providerTab);
    window.history.replaceState(null, "", url.toString());
  }, [active, activeSection, providerTab]);

  useEffect(() => {
    if (payload?.providerAvailability["ollama-local"].enabled && !ollamaLocalModels && !ollamaLocalModelsLoading) {
      void fetchOllamaLocalModels();
    }
  }, [payload, ollamaLocalModels, ollamaLocalModelsLoading]);

  useEffect(() => {
    if (payload?.providerAvailability["ollama-cloud"].secretAvailable && payload.providerAvailability["ollama-cloud"].enabled && !ollamaModels && !ollamaModelsLoading) {
      void fetchOllamaModels();
    }
  }, [payload, ollamaModels, ollamaModelsLoading]);

  useEffect(() => {
    if (payload?.providerAvailability["opencode-go"].secretAvailable && payload.providerAvailability["opencode-go"].enabled && !opencodeModels && !opencodeModelsLoading) {
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
    if (!timezoneInputIsValid(draft.overview.operatorTimezone)) {
      setMessage("Choose a valid operator timezone before saving.");
      return;
    }
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
    if (!window.confirm("Reset all Manor settings to their environment and built-in defaults?")) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await postJson<SettingsResponse>("/api/settings/reseed", {});
      setPayload(next);
      setDraft(cloneSettings(next.settings));
      setMessage("Reset complete");
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

  if (activeSection === "skills") return <SkillsDashboard active={active} />;
  if (activeSection === "usage") return <UsageDashboard active={active} />;
  if (activeSection === "network") return <RuntimeEgressDashboard active={active} />;

  if (!draft || !payload) {
    return (
      <div className="settings-page">
        <div className="settings-empty">Loading settings...</div>
      </div>
    );
  }

  const providerSettingsTabs: Record<string, string> = {
    [draft.providers.ollamaLocal.providerId]: "ollama-local",
    [draft.providers.ollamaCloud.providerId]: "ollama",
    [draft.providers.opencodeGo.providerId]: "opencode"
  };

  const savedMessage = message === "Saved" || message === "Reset complete" ? message : null;
  const errorMessage = message && !savedMessage ? message : null;
  const testing = validatingAll || Boolean(validating);
  const pullPercent = ollamaPullProgress ? Math.max(0, Math.min(100, (ollamaPullProgress.completed / ollamaPullProgress.total) * 100)) : null;
  const ollamaLocalPullEnabled = payload.settings.providers.ollamaLocal.enabled;
  const operatorTimezoneInvalid = !timezoneInputIsValid(draft.overview.operatorTimezone);
  const settingsActions = (extra?: ReactNode) => (
    <>
      {extra}
      <span className="settings-save-status" aria-live="polite">
        {dirty ? "Unsaved changes" : savedMessage ?? "All changes saved"}
      </span>
      <button className="button is-primary" type="button" onClick={save} disabled={saving || testing || !dirty || operatorTimezoneInvalid}>
        {saving ? "Saving..." : "Save changes"}
      </button>
    </>
  );

  return (
    <div className="settings-page">
      <div className="settings-content">
        {errorMessage ? <div className="settings-error settings-feedback"><WarningIcon />{errorMessage}</div> : null}
        {activeSection === "providers" ? <Section id="providers" title="Providers" actions={settingsActions()}>
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
              <Field label="Codex harness auth" hint="Connection status for the Codex app-server harness.">
                <input readOnly value={formatAuthSummary(payload.openaiCodexAuth?.codex)} />
              </Field>
              {!payload.openaiCodexAuth?.codex.loggedIn ? (
                <div className="settings-auth-actions">
                  <button className="button is-primary" type="button" onClick={() => void startAuth("codex")} disabled={authPending !== null}>
                    {authPending === "codex" ? "Starting…" : "Connect Codex harness with ChatGPT"}
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
                  {draft.providers.opencodeGo.enabled ? (
                    <>
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
                    <div className="settings-auth-error">OpenCode Go is disabled.</div>
                  )}
                </>
              ) : (
                <div className="settings-auth-error">OpenCode Go is disabled. Set OPENCODE_API_KEY in .env and restart Manor to enable it.</div>
              )}
            </SubGroup>
          ) : null}
        </Section> : null}

        {activeSection === "runtime" ? <Section id="runtime" title="Runtime" actions={settingsActions()}>
          <SubGroup title="Operator">
            <FieldGrid>
              <Field label="Operator name" hint="How Butler should refer to you in chat. Leave blank for no name.">
                <input value={draft.overview.operatorName} placeholder="(none)" onChange={(event) => update((s) => { s.overview.operatorName = event.target.value; })} />
              </Field>
              <Field label="Operator timezone" hint={operatorTimezoneInvalid ? undefined : timezonePreview(draft.overview.operatorTimezone)}>
                <input
                  value={draft.overview.operatorTimezone ?? ""}
                  list="operator-timezone-options"
                  placeholder="UTC"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={operatorTimezoneInvalid || undefined}
                  onChange={(event) => update((s) => { s.overview.operatorTimezone = event.target.value; })}
                />
                <datalist id="operator-timezone-options">
                  {OPERATOR_TIMEZONE_OPTIONS.map((option) => <option key={option.zone} value={option.zone}>{option.label}</option>)}
                </datalist>
                {operatorTimezoneInvalid ? <span className="settings-field-warning" role="alert">Choose a valid timezone, for example Africa/Lagos.</span> : null}
              </Field>
            </FieldGrid>
          </SubGroup>
          <SubGroup title="Worker defaults">
            <FieldGrid>
              <WorkerModelSelectField
                value={draft.worker.defaultModel}
                harness={draft.worker.defaultHarness}
                models={workerModels}
                onChange={(model, harness) => update((s) => {
                  s.worker.defaultModel = model;
                  s.worker.defaultHarness = harness;
                })}
              />
            </FieldGrid>
          </SubGroup>
          <SubGroup title="Vision assistance">
            <ToggleGrid>
              <Toggle
                label="Enabled"
                hint="Let text-only Butler and Worker models inspect attached images through one shared companion"
                checked={draft.vision.enabled}
                onChange={(next) => update((s) => { s.vision.enabled = next; })}
              />
            </ToggleGrid>
            {draft.vision.enabled ? (
              <>
                <div className="settings-subgroup-divider" />
                <FieldGrid>
                  <ModelSelectField
                    label="Vision companion"
                    hint={draft.vision.companionModel
                      ? taskRouteHint(draft.vision.companionModel, visionModels, "Manor chooses an authenticated vision-capable model automatically.")
                      : "Automatic chooses the first authenticated model confirmed to accept images."}
                    value={draft.vision.companionModel}
                    models={visionModels}
                    available={payload.modelTaskProviderAvailability}
                    providerSettingsTabs={providerSettingsTabs}
                    onChange={(next) => update((s) => { s.vision.companionModel = next; })}
                  />
                </FieldGrid>
                {visionModels.length === 0 ? <div className="settings-auth-error">No authenticated model is currently confirmed to accept images.</div> : null}
                <details className="settings-advanced">
                  <summary>Advanced</summary>
                  <div className="settings-advanced-body">
                    <Field label="When unavailable" hint="Choose whether an image-dependent turn should stop when the companion cannot run.">
                      <select value={draft.vision.unavailableBehavior} onChange={(event) => update((s) => { s.vision.unavailableBehavior = event.target.value === "continue" ? "continue" : "block"; })}>
                        <option value="block">Block and explain</option>
                        <option value="continue">Continue without inspection</option>
                      </select>
                    </Field>
                  </div>
                </details>
              </>
            ) : null}
          </SubGroup>
          <SubGroup title="Session titles">
            <FieldGrid>
              <ModelSelectField
                label="Preferred title model"
                hint={`${taskRouteHint(draft.modelTasks.sessionTitleModel, taskModels, "Manor chooses the first authenticated provider automatically.")} If generation fails, Manor builds a short title from the first message.`}
                value={draft.modelTasks.sessionTitleModel}
                models={taskModels}
                available={payload.modelTaskProviderAvailability}
                providerSettingsTabs={providerSettingsTabs}
                onChange={(next) => update((s) => { s.modelTasks.sessionTitleModel = next; })}
              />
            </FieldGrid>
            <details className="settings-advanced">
              <summary>Advanced</summary>
              <div className="settings-advanced-body">
                <Field label="Title timeout" hint="Manor uses the message fallback if title generation exceeds this time.">
                  <div className="settings-number-unit">
                    <input min={1} max={60} step={1} type="number" value={seconds(draft.modelTasks.sessionTitleTimeoutMs)} onChange={(event) => update((s) => { s.modelTasks.sessionTitleTimeoutMs = Number(event.target.value) * 1000; })} />
                    <span>seconds</span>
                  </div>
                </Field>
              </div>
            </details>
          </SubGroup>
        </Section> : null}

        {activeSection === "memory" ? <Section id="memory" title="Memory" actions={settingsActions()}>
          <SubGroup title="Memory processing">
            <ToggleGrid>
              <Toggle label="Synthesis and review" hint="Turn completed work into reusable memory" checked={draft.memory.synthesisEnabled} onChange={(next) => update((s) => { s.memory.synthesisEnabled = next; })} />
              <Toggle label="Automatic promotion" hint="Promote strong memory candidates without manual review" checked={draft.memory.promotionAutoResolve} onChange={(next) => update((s) => { s.memory.promotionAutoResolve = next; })} />
              <Toggle label="Semantic relationships" hint="Connect related memories in the background" checked={draft.memory.semanticEdgeReviewEnabled} onChange={(next) => update((s) => { s.memory.semanticEdgeReviewEnabled = next; })} />
            </ToggleGrid>
            <div className="settings-subgroup-divider" />
            <div className="settings-subgroup-section-head">
              <h4>Task models</h4>
              <p>Manor uses each selected model through its authenticated provider automatically.</p>
            </div>
            <FieldGrid>
              <ModelSelectField
                label="Review and synthesis model"
                hint={taskRouteHint(draft.modelTasks.memorySynthesisModel, taskModels, "Manor chooses the first authenticated provider automatically.")}
                value={draft.modelTasks.memorySynthesisModel}
                models={taskModels}
                available={payload.modelTaskProviderAvailability}
                providerSettingsTabs={providerSettingsTabs}
                onChange={(next) => update((s) => { s.modelTasks.memorySynthesisModel = next; })}
              />
              <ModelSelectField
                label="Promotion model"
                hint={draft.modelTasks.memoryPromotionModel
                  ? taskRouteHint(draft.modelTasks.memoryPromotionModel, taskModels, "Manor reuses the review and synthesis model.")
                  : "Automatic reuses the review and synthesis model."}
                value={draft.modelTasks.memoryPromotionModel}
                models={taskModels}
                available={payload.modelTaskProviderAvailability}
                providerSettingsTabs={providerSettingsTabs}
                onChange={(next) => update((s) => { s.modelTasks.memoryPromotionModel = next; })}
              />
            </FieldGrid>
            <details className="settings-advanced">
              <summary>Advanced tuning</summary>
              <div className="settings-advanced-body">
                <FieldGrid>
                  <Field label="Synthesis effort">
                    <select value={draft.memory.synthesisEffort ?? ""} onChange={(event) => update((s) => { s.memory.synthesisEffort = (event.target.value || null) as never; })}>
                      <option value="">Model default</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </Field>
                  <Field label="Task timeout"><div className="settings-number-unit"><input min={5} max={600} step={5} type="number" value={seconds(draft.memory.synthesisTimeoutMs)} onChange={(event) => update((s) => { s.memory.synthesisTimeoutMs = Number(event.target.value) * 1000; })} /><span>seconds</span></div></Field>
                  <Field label="Maximum input characters"><input min={2000} max={200000} step={1000} type="number" value={draft.memory.synthesisMaxInputChars} onChange={(event) => update((s) => { s.memory.synthesisMaxInputChars = Number(event.target.value); })} /></Field>
                  <Field label="Candidates per run"><input min={1} max={50} type="number" value={draft.memory.synthesisMaxCandidatesPerRun} onChange={(event) => update((s) => { s.memory.synthesisMaxCandidatesPerRun = Number(event.target.value); })} /></Field>
                  <Field label="Promotion batch size"><input min={1} max={50} type="number" value={draft.memory.promotionBatchSize} onChange={(event) => update((s) => { s.memory.promotionBatchSize = Number(event.target.value); })} /></Field>
                  <Field label="Promotion batches per run"><input min={1} max={25} type="number" value={draft.memory.promotionMaxBatchesPerRun} onChange={(event) => update((s) => { s.memory.promotionMaxBatchesPerRun = Number(event.target.value); })} /></Field>
                  <Field label="Promotion interval"><div className="settings-number-unit"><input min={1} max={300} type="number" value={seconds(draft.memory.promotionIntervalMs)} onChange={(event) => update((s) => { s.memory.promotionIntervalMs = Number(event.target.value) * 1000; })} /><span>seconds</span></div></Field>
                  <Field label="Relationship review batch"><input min={1} max={50} type="number" value={draft.memory.semanticEdgeReviewBatchSize} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewBatchSize = Number(event.target.value); })} /></Field>
                  <Field label="Relationship review interval"><div className="settings-number-unit"><input min={5} max={1800} step={5} type="number" value={seconds(draft.memory.semanticEdgeReviewIntervalMs)} onChange={(event) => update((s) => { s.memory.semanticEdgeReviewIntervalMs = Number(event.target.value) * 1000; })} /><span>seconds</span></div></Field>
                </FieldGrid>
              </div>
            </details>
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
            </FieldGrid>
            <details className="settings-advanced">
              <summary>Advanced tuning</summary>
              <div className="settings-advanced-body">
                <FieldGrid>
                  <Field label="Request timeout"><div className="settings-number-unit"><input min={1} max={600} type="number" value={seconds(draft.embeddings.timeoutMs)} onChange={(event) => update((s) => { s.embeddings.timeoutMs = Number(event.target.value) * 1000; })} /><span>seconds</span></div></Field>
                  <Field label="Backfill batch size"><input min={1} max={32} type="number" value={draft.embeddings.backfillBatchSize} onChange={(event) => update((s) => { s.embeddings.backfillBatchSize = Number(event.target.value); })} /></Field>
                </FieldGrid>
              </div>
            </details>
          </SubGroup>
        </Section> : null}

        {activeSection === "diagnostics" ? <Section
          id="diagnostics"
          title="Diagnostics"
          actions={settingsActions(
            <button
              className="button is-primary"
              type="button"
              onClick={() => void validateAll()}
              disabled={saving || testing}
            >
              {validatingAll ? "Testing all..." : "Test all"}
            </button>
          )}
        >
          <SubGroup title="Activity watchdogs">
            <p className="settings-subgroup-copy">Live supervision for the selected session's Worker handoffs and review activity.</p>
            {watchdogError ? <div className="settings-watchdog-error" role="alert">{watchdogError}</div> : null}
            {!pairId ? (
              <div className="settings-watchdog-empty">Select a session to inspect its activity watchdogs.</div>
            ) : watchdogDiagnostics?.watchdogs.length ? (
              <div className="settings-watchdog-table" role="table" aria-label="Active activity watchdogs">
                <div className="settings-watchdog-row is-head" role="row">
                  <span role="columnheader">Supervision</span>
                  <span role="columnheader">Target</span>
                  <span role="columnheader">Cadence</span>
                  <span role="columnheader">Checks</span>
                </div>
                {watchdogDiagnostics.watchdogs.map((watchdog) => (
                  <div className="settings-watchdog-row" role="row" key={watchdog.id}>
                    <strong role="cell">{watchdog.label}</strong>
                    <span className="is-target" role="cell" title={watchdog.target ?? watchdog.id}>{watchdogTarget(watchdog)}</span>
                    <span className="is-cadence" role="cell">Every {watchdogCadence(watchdog.intervalMs)}</span>
                    <span className={`is-checks ${watchdog.checkCount > 0 ? "" : "is-waiting"}`} role="cell">{watchdog.checkCount > 0 ? watchdog.checkCount.toLocaleString() : "Waiting"}</span>
                  </div>
                ))}
              </div>
            ) : watchdogDiagnostics ? (
              <div className="settings-watchdog-empty">No handoffs or reviews need supervision right now.</div>
            ) : (
              <div className="settings-watchdog-empty">Loading activity watchdogs…</div>
            )}
          </SubGroup>
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
          <SubGroup title="Reset settings">
            <p className="settings-subgroup-copy">Replace saved UI settings with the current environment and built-in defaults.</p>
            <div>
              <button className="button" type="button" onClick={reseed} disabled={saving || testing}>Reset all settings</button>
            </div>
          </SubGroup>
        </Section> : null}

      </div>
    </div>
  );
}
