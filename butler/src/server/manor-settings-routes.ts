import type { Express } from "express";

import type {
  ManorSettings,
  SettingsValidationKey,
  SettingsValidationResult
} from "../shared/settings.js";
import { getActiveManorSettings, readSecretSourceValue } from "./manor-settings-runtime.js";
import type { ButlerAgentService } from "./butler-agent.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import { ollamaWebFetch, ollamaWebSearch, readOllamaWebToolsConfig } from "./ollama-web-tools.js";
import { getUnifiedWorkerCompose } from "./worker-client-router.js";
import type { ManorSettingsService } from "./manor-settings-service.js";

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
  "ollamaWebSearch",
  "ollamaWebFetch",
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
  if (!model) return result("failed", "No Ollama Cloud model is configured.");
  const response = await fetchJsonStatus(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1,
      stream: false
    })
  }, 30_000);
  return response.ok
    ? result("ok", `Completion check reached ${config.providerId}/${model}.`)
    : result("failed", `Completion check failed with HTTP ${response.status}: ${redactMessage(response.text)}`);
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
    if (target === "ollamaWebSearch") return await validateWebSearch();
    if (target === "ollamaWebFetch") return await validateWebFetch();
    return await validateEmbeddingHost(settings);
  } catch (error) {
    return result("failed", redactMessage(error));
  }
}

function settingsPayload(access: SettingsRouteAccess) {
  const codex = access.codexClient.getConnectionState();
  const piRpc = access.piRpcWorkerClient.getConnectionState();
  const butler = access.butlerAgent.getShellSnapshot().compose;
  return {
    settings: access.settingsService.getSettings(),
    provenance: access.settingsService.getProvenance(),
    availableModels: {
      butler: butler.availableModels,
      codex: codex.compose.availableModels,
      piRpc: piRpc.compose.availableModels,
      worker: getUnifiedWorkerCompose(access)
    },
    validation: access.settingsService.getValidation()
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

  access.app.post("/api/settings/validate", async (request, response) => {
    const targets = safeTargets(request.body?.target ?? request.body?.targets);
    for (const target of targets) {
      await access.settingsService.setValidation(target, await runValidation(access, target));
    }
    response.json(settingsPayload(access));
  });
}
