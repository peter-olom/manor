import type { Express } from "express";

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

async function validateOllamaCloud(settings: ManorSettings): Promise<SettingsValidationResult> {
  const config = settings.providers.ollamaCloud;
  if (!config.enabled) return result("not_configured", "Ollama Cloud provider is disabled.");
  const apiKey = await readSecretSourceValue(config.apiKeySource);
  if (!apiKey) return result("not_configured", "No API key is available from the configured secret source.");
  const model = config.models[0];
  const modelId = typeof model === "string" ? model : model?.id;
  if (!modelId) return result("failed", "No Ollama Cloud model is configured.");
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
  const apiKey = await readSecretSourceValue(config.apiKeySource);
  if (!apiKey) return result("not_configured", "No API key is available from the configured secret source.");
  const response = await fetchJsonStatus(`${config.baseUrl}/models`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${apiKey}` }
  }, 30_000);
  return response.ok
    ? result("ok", `OpenCode Go models endpoint is reachable at ${config.providerId}.`)
    : result("failed", `OpenCode Go check failed with HTTP ${response.status}: ${redactMessage(response.text)}`);
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
      return state.connected ? result("ok", "Codex worker connection is active.") : result("failed", state.lastError ?? "Codex worker is not connected.");
    }
    if (target === "piRpc") {
      const state = access.piRpcWorkerClient.getConnectionState();
      return state.compose.availableModels.length > 0 ? result("ok", `${state.compose.availableModels.length} Pi model options are available.`) : result("failed", state.lastError ?? "No Pi model options are available.");
    }
    const settings = getActiveManorSettings();
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
  return {
    settings,
    provenance: access.settingsService.getProvenance(),
    availableModels: {
      butler: butler.availableModels,
      codex: codex.compose.availableModels,
      piRpc: piRpc.compose.availableModels,
      opencodeGo: collectOpencodeGoModels(butler.availableModels, settings),
      worker: getUnifiedWorkerCompose(access)
    },
    providerAvailability,
    openaiCodexAuth: {
      butler: butlerAuth,
      codex: codexAuth
    },
    validation: access.settingsService.getValidation()
  };
}

function collectOpencodeGoModels(butlerModels: ModelOption[], settings: ManorSettings): ModelOption[] {
  const providerId = settings.providers.opencodeGo.providerId;
  return butlerModels.filter((model) => model.provider === providerId);
}

function computeProviderAvailability(settings: ManorSettings, butlerAuth: ButlerAuthStatus, codexAuth: ButlerAuthStatus): SettingsProviderAvailabilityMap {
  const ollama = settings.providers.ollamaCloud;
  const opencode = settings.providers.opencodeGo;
  const ollamaSecret = isSecretSourceAvailable(ollama.apiKeySource);
  const opencodeSecret = isSecretSourceAvailable(opencode.apiKeySource);
  const openaiEnvSecret = isSecretSourceAvailable({ type: "env", name: "OPENAI_API_KEY" });
  const openaiAuthed = openaiEnvSecret || butlerAuth.loggedIn || codexAuth.loggedIn;
  return {
    "openai-codex": {
      secretAvailable: openaiAuthed,
      enabled: true,
      reason: openaiAuthed ? null : "Set OPENAI_API_KEY or sign in with ChatGPT to use OpenAI/Codex models."
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
}
