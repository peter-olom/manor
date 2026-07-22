import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MANOR_SETTINGS, DEFAULT_SETTINGS_VALIDATION, SETTINGS_GROUP_KEYS } from "../../src/server/manor-settings-schema.js";
import { buildManorSystemAwareness, formatManorSystemAwareness } from "../../src/server/manor-system-awareness.js";
import { buildButlerManorTools } from "../../src/server/butler-agent-manor-tools.js";
import type { ModelOption } from "../../src/server/types.js";

function model(id: string, provider: string, overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id,
    label: id,
    provider,
    contextWindow: 200_000,
    maxTokens: 32_000,
    inputCapabilities: { image: "supported", source: "provider" },
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    ...overrides
  };
}

function baseAccess() {
  const settings = structuredClone(DEFAULT_MANOR_SETTINGS);
  settings.providers.ollamaLocal.enabled = true;
  settings.providers.ollamaCloud.enabled = true;
  settings.providers.opencodeGo.enabled = false;
  settings.security.contentAdmissionMode = "enforce";
  const validation = structuredClone(DEFAULT_SETTINGS_VALIDATION);
  validation.piRpc = { status: "ok", message: "Pi is healthy.", lastCheckedAt: 1_700_000_000_000 };
  validation.ollamaCloud = { status: "failed", message: "Bearer awareness-secret at https://private.example/token", lastCheckedAt: 1_700_000_000_001 };
  const provenance = Object.fromEntries(SETTINGS_GROUP_KEYS.map((key) => [key, "default"])) as never;
  const butlerModels = [
    model("gpt-test", "openai-codex"),
    model("shared-id", "ollama-local", { inputCapabilities: { image: "unsupported", source: "provider" } }),
    model("shared-id", "ollama-cloud")
  ];
  const workerModels = [
    model("gpt-test", "openai-codex"),
    model("shared-id", "ollama-cloud")
  ];
  return {
    settingsService: {
      getSettings: () => structuredClone(settings),
      getProvenance: () => structuredClone(provenance),
      getValidation: () => structuredClone(validation)
    },
    butlerAgent: {
      getShellSnapshot: () => ({
        ready: true,
        lastError: null,
        tools: [{ name: "inspect_manor_system", label: "Inspect", description: "Read awareness.", uiEffects: [] }],
        compose: {
          provider: "openai-codex",
          model: "gpt-test",
          thinkingLevel: "medium",
          availableModels: butlerModels
        }
      }) as never,
      getButlerAuthStatus: () => ({ mode: "chatgpt" as const, loggedIn: true, validationError: null, lastValidatedAt: 1_700_000_000_002, credentialRevision: "must-not-escape" })
    },
    piRpcWorkerClient: {
      getConnectionState: () => ({
        connected: true,
        lastError: null,
        compose: { provider: "openai-codex", model: "gpt-test", effort: "high" as const, availableModels: workerModels }
      }),
      getThreadModelOption: () => null,
      getThreadModelIdentity: () => null,
      getAuthStatus: async () => ({ mode: "chatgpt" as const, loggedIn: true, validationError: null, lastValidatedAt: 1_700_000_000_003, credentialRevision: "worker-revision-secret" })
    },
    runtimeEgress: {
      list: async () => ({
        mode: "restricted" as const,
        domains: [
          { domain: "private.internal", source: "operator" as const, removable: true },
          { domain: "api.openai.com", source: "built-in" as const, removable: false }
        ]
      })
    },
    hostController: {
      getSourceState: async () => ({
        ok: true as const,
        checkout: { head: "abc123", dirty: true, fingerprint: "fingerprint", builtAt: null, changedFileCount: 1, changedFiles: ["/secret/workspace/private.ts"], changedFilesTruncated: false },
        runtime: {
          relation: "differs_from_checkout" as const,
          summary: "Running source differs from the active checkout.",
          services: [{ service: "butler", containerId: "secret-container-id", imageId: "secret-image-id", startedAt: "2026-07-22T12:00:00Z", head: "def456", dirty: false, fingerprint: "runtime-fingerprint", builtAt: null }]
        }
      })
    },
    runtimeBroker: {
      listLeases: async () => [{ id: "preview-secret-id", title: "Private preview", status: "ready", env: { TOKEN: "lease-secret" } }],
      listStacks: async () => [{ id: "stack-secret-id", title: "Private stack", status: "ready", volumeNames: ["secret-volume"] }],
      listServices: async () => [{ id: "service-secret-id", title: "Private service", status: "running", env: { PASSWORD: "service-secret" } }],
      getDesktopProofStatus: async () => ({ available: true, status: "ready", message: "ready", health: { ok: true, display: ":99", vncUrl: "http://secret-vnc", activeSessionCount: 2 } })
    },
    env: {
      BUTLER_HOT_RELOAD: "1",
      PI_VERSION: "0.80.6",
      OLLAMA_API_KEY: "awareness-secret"
    },
    now: () => 1_700_000_000_100
  };
}

test("Manor awareness keeps agent, provider, model, security, and health facts distinct", async () => {
  const snapshot = await buildManorSystemAwareness(baseAccess(), "all");

  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.generatedAt, 1_700_000_000_100);
  assert.equal(snapshot.agents?.butler.harness, "pi");
  assert.equal(snapshot.agents?.worker.runtime, "pi-rpc");
  assert.equal(snapshot.agents?.worker.selected.model, "gpt-test");
  assert.equal(snapshot.models?.butler[0]?.contextWindow, 200_000);
  assert.equal(snapshot.models?.butler[0]?.maxTokens, 32_000);
  assert.ok(snapshot.models?.butler.some((entry) => entry.provider === "ollama-local" && entry.id === "shared-id"));
  assert.ok(snapshot.models?.worker.some((entry) => entry.provider === "ollama-cloud" && entry.id === "shared-id"));

  const openAi = snapshot.providers?.find((provider) => provider.id === "openai-codex");
  const ollamaCloud = snapshot.providers?.find((provider) => provider.id === "ollama-cloud");
  assert.equal(openAi?.credentialAvailable, true);
  assert.equal(openAi?.credentialAcceptedLocally, true);
  assert.equal(openAi?.locallyUsable, true);
  assert.equal(openAi?.lastKnownReachable, null);
  assert.equal(ollamaCloud?.credentialAvailable, true);
  assert.equal(ollamaCloud?.credentialAcceptedLocally, null);
  assert.equal(ollamaCloud?.locallyUsable, true);
  assert.equal(ollamaCloud?.lastKnownReachable, false);
  assert.deepEqual(openAi?.selectedBy, ["Butler", "Worker"]);

  assert.deepEqual(snapshot.security?.runtimeEgress.domainCounts, { total: 2, builtIn: 1, operator: 1 });
  assert.equal(snapshot.services?.previews?.total, 1);
  assert.equal(snapshot.services?.managedServices?.byStatus.running, 1);
  assert.equal(snapshot.capabilities?.butlerTools[0]?.name, "inspect_manor_system");
  assert.ok(snapshot.capabilities?.workerTools.some((tool) => tool.name === "manor_system_inspect" && tool.source === "manor-extension"));
  assert.ok(snapshot.capabilities?.workerTools.some((tool) => tool.name === "read" && tool.source === "pi-core"));
  assert.equal(snapshot.configuration?.runtime.hotReload, true);
  assert.equal(snapshot.errors.length, 0);
});

test("Manor awareness uses the invoking Butler and Worker thread selections", async () => {
  const access = baseAccess();
  let requestedThreadId: string | null = null;
  access.piRpcWorkerClient.getThreadModelOption = (threadId: string) => {
    requestedThreadId = threadId;
    return model("thread-model", "ollama-cloud");
  };
  const pairShell = access.butlerAgent.getShellSnapshot();
  pairShell.compose.provider = "ollama-local";
  pairShell.compose.model = "shared-id";

  const snapshot = await buildManorSystemAwareness(access, "agents", {
    butler: { shell: pairShell, auth: access.butlerAgent.getButlerAuthStatus() },
    workerThreadId: "worker-thread-7",
    workerEffort: "max"
  });

  assert.equal(requestedThreadId, "worker-thread-7");
  assert.equal(snapshot.agents?.butler.selected.model, "shared-id");
  assert.equal(snapshot.agents?.worker.selected.provider, "ollama-cloud");
  assert.equal(snapshot.agents?.worker.selected.model, "thread-model");
  assert.equal(snapshot.agents?.worker.selected.thinking, "max");
});

test("selected model markers remain provider-specific when IDs overlap", async () => {
  const access = baseAccess();
  access.piRpcWorkerClient.getThreadModelOption = () => model("shared-id", "ollama-cloud");
  const pairShell = access.butlerAgent.getShellSnapshot();
  pairShell.compose.provider = "ollama-local";
  pairShell.compose.model = "shared-id";

  const snapshot = await buildManorSystemAwareness(access, "models", {
    butler: { shell: pairShell, auth: access.butlerAgent.getButlerAuthStatus() },
    workerThreadId: "worker-overlap"
  });

  assert.deepEqual(snapshot.models?.butler.filter((entry) => entry.selected).map((entry) => entry.provider), ["ollama-local"]);
  assert.deepEqual(snapshot.models?.worker.filter((entry) => entry.selected).map((entry) => entry.provider), ["ollama-cloud"]);
});

test("Worker awareness preserves a thread model that is no longer in the live registry", async () => {
  const access = baseAccess();
  access.piRpcWorkerClient.getThreadModelOption = () => null;
  access.piRpcWorkerClient.getThreadModelIdentity = () => ({ provider: "retired-provider", model: "retired-model" });

  const snapshot = await buildManorSystemAwareness(access, "agents", { workerThreadId: "worker-retired-model" });

  assert.equal(snapshot.agents?.worker.selected.provider, "retired-provider");
  assert.equal(snapshot.agents?.worker.selected.model, "retired-model");
  assert.equal(snapshot.agents?.worker.selected.availableInRegistry, false);
});

test("Worker awareness does not borrow a changed global effort for a thread using its model default", async () => {
  const access = baseAccess();
  access.piRpcWorkerClient.getConnectionState = () => ({
    connected: true,
    lastError: null,
    compose: { provider: "openai-codex", model: "gpt-test", effort: "xhigh", availableModels: [model("gpt-test", "openai-codex", { defaultReasoningEffort: "medium" })] }
  });
  access.piRpcWorkerClient.getThreadModelOption = () => model("gpt-test", "openai-codex", { defaultReasoningEffort: "medium" });
  access.piRpcWorkerClient.getThreadModelIdentity = () => ({ provider: "openai-codex", model: "gpt-test" });

  const snapshot = await buildManorSystemAwareness(access, "agents", { workerThreadId: "worker-default-effort", workerEffort: null });

  assert.equal(snapshot.agents?.worker.selected.thinking, "medium");
});

test("Worker awareness reports an unloaded paired Butler without falling back to the root Butler", async () => {
  const snapshot = await buildManorSystemAwareness(baseAccess(), "agents", { butler: null, workerThreadId: "worker-unloaded-pair" });

  assert.equal(snapshot.agents?.butler.runtimeAvailable, false);
  assert.equal(snapshot.agents?.butler.availabilityBasis, "paired-runtime-unloaded");
  assert.equal(snapshot.agents?.butler.selected.model, null);
  assert.equal(snapshot.agents?.butler.authentication.mode, "unknown");
});

test("Manor awareness allowlists output and redacts free-text failures", async () => {
  const access = baseAccess();
  access.runtimeEgress.list = async () => { throw new Error("Bearer awareness-secret at https://private.example/token /secret/path/file"); };
  access.hostController.getSourceState = async () => { throw new Error("sk-supersecretvalue /secret/source/path"); };
  const snapshot = await buildManorSystemAwareness(access, "all");
  const serialized = JSON.stringify(snapshot);

  for (const forbidden of [
    "awareness-secret",
    "private.example",
    "private.internal",
    "must-not-escape",
    "worker-revision-secret",
    "secret-container-id",
    "secret-image-id",
    "preview-secret-id",
    "stack-secret-id",
    "service-secret-id",
    "lease-secret",
    "service-secret",
    "secret-vnc",
    "/secret/"
  ]) assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  for (const forbiddenKey of ["credentialRevision", "changedFiles", "containerId", "imageId", "env", "token", "password", "headers", "logs", "raw"]) {
    assert.equal(new RegExp(`\\"${forbiddenKey}\\"`, "i").test(serialized), false, `exposed key ${forbiddenKey}`);
  }
  assert.ok(snapshot.errors.some((error) => error.component === "runtime egress"));
  assert.deepEqual(snapshot.security?.runtimeEgress.domainCounts, { total: null, builtIn: null, operator: null });
  assert.match(formatManorSystemAwareness(snapshot), /Unavailable observations/);
});

test("Focused awareness sections skip unrelated read-only health calls", async () => {
  const access = baseAccess();
  let externalReads = 0;
  access.runtimeEgress.list = async () => { externalReads += 1; return { mode: "internet", domains: [] }; };
  access.hostController.getSourceState = async () => { externalReads += 1; throw new Error("should not run"); };
  access.runtimeBroker.listLeases = async () => { externalReads += 1; return []; };
  access.runtimeBroker.listStacks = async () => { externalReads += 1; return []; };
  access.runtimeBroker.listServices = async () => { externalReads += 1; return []; };
  access.runtimeBroker.getDesktopProofStatus = async () => { externalReads += 1; throw new Error("should not run"); };

  const snapshot = await buildManorSystemAwareness(access, "providers");
  assert.equal(externalReads, 0);
  assert.ok(snapshot.providers);
  assert.equal(snapshot.security, undefined);
  assert.equal(snapshot.services, undefined);
  assert.deepEqual(snapshot.errors, []);
});

test("Butler system inspection returns concise text and the structured read-only snapshot", async () => {
  const requested: string[] = [];
  const tools = buildButlerManorTools({
    defineButlerTool: (definition: unknown) => definition,
    getToolUiEffects: () => [],
    readSystemAwareness: async (section = "overview") => {
      requested.push(section);
      return { schemaVersion: 1, generatedAt: 1_700_000_000_000, section, readOnly: true, providers: [], provenance: [], errors: [] };
    }
  } as never) as unknown as Array<{
    name: string;
    execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: { snapshot: { readOnly: boolean }; mutationPerformed: boolean } }>;
  }>;
  const inspect = tools.find((tool) => tool.name === "inspect_manor_system");
  assert.ok(inspect);

  const result = await inspect.execute("awareness-1", { section: "providers" });
  assert.deepEqual(requested, ["providers"]);
  assert.match(result.content[0]?.text ?? "", /Mode: read-only/);
  assert.equal(result.details.snapshot.readOnly, true);
  assert.equal(result.details.mutationPerformed, false);
});
