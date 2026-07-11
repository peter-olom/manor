import type { Express, Response } from "express";

import type {
  ManorSettings,
  SettingsProviderAvailabilityMap,
  SettingsValidationKey,
  SettingsValidationResult
} from "../shared/settings.js";
import { getActiveManorSettings, isSecretSourceAvailable, readSecretSourceValue } from "./manor-settings-runtime.js";
import type { ButlerAgentService } from "./butler-agent.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import { ollamaWebFetch, ollamaWebSearch, readOllamaWebToolsConfig } from "./ollama-web-tools.js";
import { opencodeWebFetch, opencodeWebSearch, readOpencodeWebToolsConfig } from "./opencode-web-tools.js";
import { getUnifiedWorkerCompose } from "./worker-client-router.js";
import type { ManorSettingsService } from "./manor-settings-service.js";
import type { ModelOption, ButlerAuthStatus } from "./types.js";
import type { SettingsGroupKey } from "../shared/settings.js";
import { assertOllamaLocalBaseUrl, fetchOllamaLocalModels, nativeOllamaBaseUrl, normalizeOllamaModelName, type OllamaLocalModelInfo } from "./ollama-local-models.js";
import { fetchOllamaCloudModelsCached } from "./ollama-cloud-models.js";
import { fetchOpencodeGoModelsCached } from "./opencode-go-models.js";

type SettingsRouteAccess = {
  app: Express;
  settingsService: ManorSettingsService;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  piRpcWorkerClient: PiRpcWorkerClient;
  butlerAgent: ButlerAgentService;
  onSettingsChanged: () => Promise<void>;
};

const VALIDATION_KEYS: SettingsValidationKey[] = [
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

function redactMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[a-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]")
    .slice(0, 800);
}

function result(status: SettingsValidationResult["status"], message: string | null): SettingsValidationResult {
  return { status, message, lastCheckedAt: Date.now() };
}

function safeTargets(value: unknown): SettingsValidationKey[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : VALIDATION_KEYS;
  const targets = list.filter((entry): entry is SettingsValidationKey => typeof entry === "string" && VALIDATION_KEYS.includes(entry as SettingsValidationKey));
  return targets.length > 0 ? [...new Set(targets)] : VALIDATION_KEYS;
}

async function fetchJsonStatus(url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text().catch(() => "") };
  } finally {
    clearTimeout(timeout);
  }
}

async function validateOllamaLocal(settings: ManorSettings): Promise<SettingsValidationResult> {
  const config = settings.providers.ollamaLocal;
  if (!config.enabled) return result("not_configured", "Ollama Local provider is disabled.");
  const baseUrl = assertOllamaLocalBaseUrl(config.baseUrl, "Ollama Local OpenAI-compatible base URL");
  const configuredModel = config.models[0];
  const configuredModelId = typeof configuredModel === "string" ? configuredModel : configuredModel?.id;
  const discovered = configuredModelId
    ? []
    : await fetchOllamaLocalModels({ nativeBaseUrl: config.nativeBaseUrl || nativeOllamaBaseUrl(config.baseUrl), timeoutMs: 10_000 });
  const modelId = configuredModelId ?? discovered[0]?.id;
  if (!modelId) return result("not_configured", "No local chat model is available. Pull a chat model in Ollama, then retry.");
  const apiKey = config.apiKeySource ? await readSecretSourceValue(config.apiKeySource) : null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.authHeader) headers.Authorization = `Bearer ${apiKey || "ollama"}`;
  const response = await fetchJsonStatus(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false
    })
  }, 30_000);
  return response.ok
    ? result("ok", `Completion check reached ${config.providerId}/${modelId}.`)
    : result("failed", `Completion check failed with HTTP ${response.status}: ${redactMessage(response.text)}`);
}

async function validateOllamaCloud(settings: ManorSettings): Promise<SettingsValidationResult> {
  const config = settings.providers.ollamaCloud;
  if (!config.enabled) return result("not_configured", "Ollama Cloud provider is disabled.");
  const apiKey = await readSecretSourceValue(config.apiKeySource);
  if (!apiKey) return result("not_configured", "No API key is available from the configured secret source.");
  const model = config.models[0];
  const configuredModelId = typeof model === "string" ? model : model?.id;
  const discoveredModelId = configuredModelId
    ? null
    : (await fetchOllamaCloudModelsCached(settings, { timeoutMs: 10_000 }).catch(() => []))[0]?.id ?? null;
  const modelId = configuredModelId ?? discoveredModelId;
  if (!modelId) return result("failed", "No Ollama Cloud model is configured or discoverable.");
  const response = await fetchJsonStatus(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false
    })
  }, 30_000);
  return response.ok
    ? result("ok", `Completion check reached ${config.providerId}/${modelId}.`)
    : result("failed", `Completion check failed with HTTP ${response.status}: ${redactMessage(response.text)}`);
}

async function validateOpencodeGo(settings: ManorSettings): Promise<SettingsValidationResult> {
  const config = settings.providers.opencodeGo;
  if (!config.enabled) return result("not_configured", "OpenCode Go provider is disabled.");
  const models = await fetchOpencodeGoModelsCached(settings, { force: true, timeoutMs: 10_000 });
  return models.length > 0
    ? result("ok", `${models.length} OpenCode Go models are available from OpenCode Go.`)
    : result("failed", "No OpenCode Go models are available from OpenCode Go.");
}

async function validateWebSearch(): Promise<SettingsValidationResult> {
  const config = await readOllamaWebToolsConfig();
  if (!config.enabled) return result("not_configured", "Ollama web search is disabled or missing an API key.");
  await ollamaWebSearch({ query: "Manor settings validation", maxResults: 1 }, config);
  return result("ok", "Ollama web_search returned a response.");
}

async function validateWebFetch(): Promise<SettingsValidationResult> {
  const config = await readOllamaWebToolsConfig();
  if (!config.enabled) return result("not_configured", "Ollama web fetch is disabled or missing an API key.");
  await ollamaWebFetch({ url: "https://example.com" }, config);
  return result("ok", "Ollama web_fetch returned a response.");
}

async function validateOpencodeWebSearch(): Promise<SettingsValidationResult> {
  const config = readOpencodeWebToolsConfig();
  if (!config.enabled) return result("not_configured", "OpenCode web search is disabled.");
  await opencodeWebSearch({ query: "Manor settings validation", maxResults: 1 }, config);
  return result("ok", "OpenCode web_search returned a response.");
}

async function validateOpencodeWebFetch(): Promise<SettingsValidationResult> {
  const config = readOpencodeWebToolsConfig();
  if (!config.enabled) return result("not_configured", "OpenCode web fetch is disabled.");
  await opencodeWebFetch({ url: "https://example.com" }, config);
  return result("ok", "OpenCode web_fetch returned a response.");
}

async function validateEmbeddingHost(settings: ManorSettings): Promise<SettingsValidationResult> {
  const config = settings.embeddings;
  if (!config.enabled) return result("not_configured", "Memory embeddings are disabled.");
  const response = await fetchJsonStatus(`${config.host}/api/tags`, { method: "GET" }, Math.min(config.timeoutMs, 30_000));
  return response.ok
    ? result("ok", `Embedding host is reachable for ${config.model}.`)
    : result("failed", `Embedding host failed with HTTP ${response.status}: ${redactMessage(response.text)}`);
}

async function runValidation(access: SettingsRouteAccess, target: SettingsValidationKey): Promise<SettingsValidationResult> {
  try {
    if (target === "codex") {
      const state = access.codexClient.getConnectionState();
      return state.connected ? result("ok", "Codex app-server harness connection is active.") : result("failed", state.lastError ?? "Codex app-server harness is not connected.");
    }
    if (target === "piRpc") {
      const state = access.piRpcWorkerClient.getConnectionState();
      return state.compose.availableModels.length > 0 ? result("ok", `${state.compose.availableModels.length} Pi model options are available.`) : result("failed", state.lastError ?? "No Pi model options are available.");
    }
    const settings = getActiveManorSettings();
    if (target === "ollamaLocal") return await validateOllamaLocal(settings);
    if (target === "ollamaCloud") return await validateOllamaCloud(settings);
    if (target === "opencodeGo") return await validateOpencodeGo(settings);
    if (target === "ollamaWebSearch") return await validateWebSearch();
    if (target === "ollamaWebFetch") return await validateWebFetch();
    if (target === "opencodeWebSearch") return await validateOpencodeWebSearch();
    if (target === "opencodeWebFetch") return await validateOpencodeWebFetch();
    return await validateEmbeddingHost(settings);
  } catch (error) {
    return result("failed", redactMessage(error));
  }
}

function settingsPayload(access: SettingsRouteAccess) {
  const codex = access.codexClient.getConnectionState();
  const piRpc = access.piRpcWorkerClient.getConnectionState();
  const butler = access.butlerAgent.getShellSnapshot().compose;
  const settings = access.settingsService.getSettings();
  const butlerAuth = access.butlerAgent.getButlerAuthStatus();
  const codexAuth = access.butlerAgent.getCodexAuthStatus();
  const providerAvailability = computeProviderAvailability(settings, butlerAuth, codexAuth);
  const modelTaskProviderAvailability = computeModelTaskProviderAvailability(providerAvailability, codexAuth);
  const workerCompose = getUnifiedWorkerCompose({
    ...access,
    getCodexAuthStatus: () => codexAuth,
    getWorkerAffinity: () => typeof access.butlerAgent.getWorkerAffinity === "function" ? access.butlerAgent.getWorkerAffinity() : null
  });
  const modelTaskModels = collectModelTaskModels(
    [butler.availableModels, piRpc.compose.availableModels, codex.compose.availableModels],
    modelTaskProviderAvailability
  );
  return {
    settings,
    provenance: access.settingsService.getProvenance(),
    availableModels: {
      butler: butler.availableModels,
      codex: codex.compose.availableModels,
      piRpc: piRpc.compose.availableModels,
      ollamaLocal: collectOllamaLocalModels(butler.availableModels, settings),
      opencodeGo: collectOpencodeGoModels([...butler.availableModels, ...piRpc.compose.availableModels], settings),
      modelTasks: modelTaskModels,
      worker: workerCompose
    },
    providerAvailability,
    modelTaskProviderAvailability,
    openaiCodexAuth: {
      butler: butlerAuth,
      codex: codexAuth
    },
    validation: access.settingsService.getValidation()
  };
}

function computeModelTaskProviderAvailability(
  availability: SettingsProviderAvailabilityMap,
  codexAuth: ButlerAuthStatus
): SettingsProviderAvailabilityMap {
  const codexAvailable = isSecretSourceAvailable({ type: "env", name: "OPENAI_API_KEY" }) || codexAuth.loggedIn;
  return {
    ...availability,
    "openai-codex": {
      enabled: true,
      secretAvailable: codexAvailable,
      reason: codexAvailable ? null : "Set OPENAI_API_KEY or sign in to Codex to use OpenAI models for background tasks."
    }
  };
}

function collectModelTaskModels(modelSets: ModelOption[][], availability: SettingsProviderAvailabilityMap): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const model of modelSets.flat()) {
    const provider = model.provider ?? "openai-codex";
    const providerState = availability[provider as keyof SettingsProviderAvailabilityMap];
    if (!providerState?.enabled || !providerState.secretAvailable) continue;
    const id = model.id.startsWith(`${provider}/`) ? model.id : `${provider}/${model.id}`;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ ...model, id, provider });
  }
  return models;
}

function collectOllamaLocalModels(butlerModels: ModelOption[], settings: ManorSettings): ModelOption[] {
  const providerId = settings.providers.ollamaLocal.providerId;
  return butlerModels.filter((model) => model.provider === providerId);
}

function collectOpencodeGoModels(butlerModels: ModelOption[], settings: ManorSettings): ModelOption[] {
  const providerId = settings.providers.opencodeGo.providerId;
  const seen = new Set<string>();
  return butlerModels.filter((model) => {
    if (model.provider !== providerId && model.provider !== "opencode-go") return false;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeProviderAvailability(settings: ManorSettings, butlerAuth: ButlerAuthStatus, codexAuth: ButlerAuthStatus): SettingsProviderAvailabilityMap {
  const ollamaLocal = settings.providers.ollamaLocal;
  const ollama = settings.providers.ollamaCloud;
  const opencode = settings.providers.opencodeGo;
  const ollamaSecret = isSecretSourceAvailable(ollama.apiKeySource);
  const opencodeSecret = isSecretSourceAvailable(opencode.apiKeySource);
  const openaiEnvSecret = isSecretSourceAvailable({ type: "env", name: "OPENAI_API_KEY" });
  const openaiAuthed = openaiEnvSecret || butlerAuth.loggedIn || codexAuth.loggedIn;
  const availability: SettingsProviderAvailabilityMap = {
    "openai-codex": {
      secretAvailable: openaiAuthed,
      enabled: true,
      reason: openaiAuthed ? null : "Set OPENAI_API_KEY or sign in with ChatGPT to use OpenAI/Codex models."
    },
    "ollama-local": {
      secretAvailable: true,
      enabled: ollamaLocal.enabled,
      reason: ollamaLocal.enabled ? null : "Enable Ollama Local to use local models."
    },
    "ollama-cloud": {
      secretAvailable: ollamaSecret,
      enabled: ollama.enabled,
      reason: ollamaSecret ? null : "Set OLLAMA_API_KEY (or OLLAMA_API_KEY_FILE) before starting Manor to use Ollama Cloud."
    },
    "opencode-go": {
      secretAvailable: opencodeSecret,
      enabled: opencode.enabled,
      reason: opencodeSecret ? null : "Set OPENCODE_API_KEY (or OPENCODE_API_KEY_FILE) before starting Manor to use OpenCode Go."
    }
  };
  availability[ollamaLocal.providerId] = availability["ollama-local"];
  availability[ollama.providerId] = availability["ollama-cloud"];
  availability[opencode.providerId] = availability["opencode-go"];
  return availability;
}

async function fetchOllamaLocalModelsForSettings(settings: ManorSettings): Promise<OllamaLocalModelInfo[]> {
  const config = settings.providers.ollamaLocal;
  return fetchOllamaLocalModels({ nativeBaseUrl: config.nativeBaseUrl || nativeOllamaBaseUrl(config.baseUrl), timeoutMs: 10_000 });
}

function writePullEvent(response: Response, event: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(event)}\n`);
}

function modelNameMatchesPulled(id: string, requested: string): boolean {
  return id === requested || id === `${requested}:latest` || id.replace(/:latest$/, "") === requested;
}

async function streamOllamaLocalPull(access: SettingsRouteAccess, model: string, response: Response, signal?: AbortSignal): Promise<void> {
  const settings = getActiveManorSettings();
  const config = settings.providers.ollamaLocal;
  if (!config.enabled) throw new Error("Ollama Local provider is disabled.");
  const nativeBase = assertOllamaLocalBaseUrl(nativeOllamaBaseUrl(config.nativeBaseUrl || nativeOllamaBaseUrl(config.baseUrl)), "Ollama Local native base URL");
  const upstream = await fetch(`${nativeBase}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`Ollama pull failed with HTTP ${upstream.status}: ${redactMessage(text)}`);
  }

  let failed = false;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      event = { status: trimmed };
    }
    if (typeof event.error === "string" && event.error.trim()) failed = true;
    writePullEvent(response, event);
  };

  while (true) {
    if (signal?.aborted) throw new Error("Ollama pull was cancelled.");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  }
  buffer += decoder.decode();
  processLine(buffer);

  if (!failed) {
    await access.onSettingsChanged();
    let chatModels: OllamaLocalModelInfo[];
    try {
      chatModels = await fetchOllamaLocalModelsForSettings(getActiveManorSettings());
    } catch (error) {
      writePullEvent(response, { status: `${model} was pulled, but Manor could not refresh Ollama model inventory: ${redactMessage(error)}`, warning: true, done: true });
      return;
    }
    const chatCapable = chatModels.some((entry) => modelNameMatchesPulled(entry.id, model));
    writePullEvent(response, chatCapable
      ? { status: "Model inventory refreshed.", done: true }
      : { status: `${model} was pulled, but Ollama does not report it as a chat model.`, warning: true, done: true });
  }
}

export function registerManorSettingsRoutes(access: SettingsRouteAccess): void {
  access.app.get("/api/settings", (_request, response) => {
    response.json(settingsPayload(access));
  });

  access.app.patch("/api/settings", async (request, response) => {
    try {
      await access.settingsService.patch(request.body ?? {});
      await access.onSettingsChanged();
      response.json(settingsPayload(access));
    } catch (error) {
      response.status(400).json({ error: redactMessage(error) });
    }
  });

  access.app.post("/api/settings/reseed", async (_request, response) => {
    try {
      await access.settingsService.reseedUnset();
      await access.onSettingsChanged();
      response.json(settingsPayload(access));
    } catch (error) {
      response.status(400).json({ error: redactMessage(error) });
    }
  });

  access.app.post("/api/settings/restore-group", async (request, response) => {
    try {
      const group = typeof request.body?.group === "string" ? request.body.group as SettingsGroupKey : null;
      if (!group) {
        response.status(400).json({ error: "Missing 'group' in request body." });
        return;
      }
      await access.settingsService.restoreGroup(group);
      await access.onSettingsChanged();
      response.json(settingsPayload(access));
    } catch (error) {
      response.status(400).json({ error: redactMessage(error) });
    }
  });

  access.app.post("/api/settings/validate", async (request, response) => {
    const targets = safeTargets(request.body?.target ?? request.body?.targets);
    for (const target of targets) {
      await access.settingsService.setValidation(target, await runValidation(access, target));
    }
    response.json(settingsPayload(access));
  });

  access.app.get("/api/settings/providers/ollama-cloud/models", async (_request, response) => {
    try {
      const settings = getActiveManorSettings();
      const models = await fetchOllamaCloudModelsCached(settings);
      response.json({ models });
    } catch (error) {
      response.status(500).json({ error: redactMessage(error) });
    }
  });

  access.app.get("/api/settings/providers/ollama-local/models", async (_request, response) => {
    try {
      const settings = getActiveManorSettings();
      const models = await fetchOllamaLocalModelsForSettings(settings);
      response.json({ models });
    } catch (error) {
      response.status(500).json({ error: redactMessage(error) });
    }
  });

  access.app.post("/api/settings/providers/ollama-local/pull", async (request, response) => {
    let model: string;
    try {
      model = normalizeOllamaModelName(request.body?.model);
    } catch (error) {
      response.status(400).json({ error: redactMessage(error) });
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Accel-Buffering", "no");
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      writePullEvent(response, { status: `Pulling ${model}...` });
      await streamOllamaLocalPull(access, model, response, controller.signal);
    } catch (error) {
      writePullEvent(response, { error: redactMessage(error) });
    } finally {
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  });

  access.app.get("/api/settings/providers/opencode-go/models", async (_request, response) => {
    try {
      const settings = getActiveManorSettings();
      const models = await fetchOpencodeGoModelsCached(settings);
      response.json({ models });
    } catch (error) {
      response.status(500).json({ error: redactMessage(error) });
    }
  });
}
