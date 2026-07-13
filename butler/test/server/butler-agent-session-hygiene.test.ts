import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import {
  BUTLER_BACKGROUND_PROMPT_PREFIX,
  BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX,
  collapseCallbackDuplicateMessages,
  contentAttachmentSummary,
  sanitizeHistoryMessages,
  serializeMessages,
  summarizeToolResultDetails,
  type PendingChatCallback
} from "../../src/server/butler-agent-helpers.js";
import { ButlerAgentService } from "../../src/server/butler-agent.js";
import {
  activateOperatorReferences,
  clearPendingOperatorPrompts,
  commitPendingOperatorPrompt,
  dropTrailingFailedButlerTurns,
  hasBlockingStopRequest,
  getVisibleButlerMessages,
  keepPendingOperatorPromptsBefore,
  applyManagedButlerDefaults,
  attachCompletedActivityTraceToDelegationAcknowledgement,
  registerPendingOperatorPrompt,
  removeCommittedPendingOperatorPrompt,
  removePendingOperatorPrompt,
  stopButlerPrompt,
  syncOperatorMessagesFromSessionFiles,
  updateButlerComposeSettings
} from "../../src/server/butler-agent-session.js";
import { createManorModelRegistry, registerManorProviders } from "../../src/server/model-provider-config.js";
import { clearOllamaCloudModelsCache } from "../../src/server/ollama-cloud-models.js";
import { getActiveManorSettings, setActiveManorSettings } from "../../src/server/manor-settings-runtime.js";
import { runSerializedJobMutation } from "../../src/server/butler-job-mutation-guard.js";
import {
  backfillOperatorMessagesFromSessionFiles,
  normalizeOperatorMessages,
  upsertOperatorMessage,
  upsertProviderBackedOperatorMessage
} from "../../src/server/butler-operator-messages.js";

test("queued operator turns expose only their own attachment references", async () => {
  const scope: { activeOperatorReferences: { imageReferenceIds: string[]; fileReferenceIds: string[] } | null } = { activeOperatorReferences: null };
  let releaseFirst: (() => void) | null = null;
  let markFirstStarted: (() => void) | null = null;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const seen: string[][] = [];
  let queue: Promise<void> = Promise.resolve();
  const schedule = (imageReferenceId: string) => {
    const references = { imageReferenceIds: [imageReferenceId], fileReferenceIds: [] };
    const execute = async () => {
      const clear = activateOperatorReferences(scope, references);
      seen.push(scope.activeOperatorReferences?.imageReferenceIds ?? []);
      if (imageReferenceId === "image-first") {
        markFirstStarted?.();
        await firstGate;
      }
      clear();
    };
    const scheduled = queue.then(execute, execute);
    queue = scheduled.then(() => undefined);
    return scheduled;
  };

  const first = schedule("image-first");
  const second = schedule("image-second");
  await firstStarted;
  assert.deepEqual(scope.activeOperatorReferences?.imageReferenceIds, ["image-first"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(seen, [["image-first"], ["image-second"]]);
  assert.equal(scope.activeOperatorReferences, null);
});

function pendingAccess() {
  return {
    session: null,
    pending: false,
    stopRequestedAt: null,
    stopRequestSequence: 0,
    lastError: null,
    operatorMessages: [],
    pendingOperatorMessages: [],
    pendingOperatorMessageSequence: 0,
    pendingOperatorMessageRevision: 0,
    emit() {
      return true;
    }
  };
}

function reviewCallback(
  threadId: string,
  reviewState: PendingChatCallback["reviewState"],
  blockedCloseoutReason: string | null = null
): PendingChatCallback {
  return {
    threadId,
    callbackState: "received_worker_callback",
    resolutionState: "received_worker_callback",
    requestedAt: 1,
    lastEventAt: 1,
    lastWorkerStatusSeen: "idle",
    lastTerminalReportAt: 1,
    lastPrivateSteerText: null,
    lastPrivateSteerAt: null,
    nextWorkerReportAction: "review",
    operatorCloseoutStatus: "owed",
    owesOperatorReply: true,
    closeoutChannel: "none",
    reviewState,
    reviewReason: "worker_callback",
    blockedCloseoutReason,
    blockedCloseoutReportAt: blockedCloseoutReason ? 1 : null,
    closedAt: null,
    updatedAt: 1
  };
}

test("model settings refresh preserves paused adversarial reviews", async (t) => {
  setActiveManorSettings(getActiveManorSettings({} as NodeJS.ProcessEnv));
  t.after(() => setActiveManorSettings(null));

  const automatic = reviewCallback("automatic", "blocked", "Adversarial review paused after 3 failed attempts: timeout");
  const operator = reviewCallback("operator", "blocked", "Adversarial review stopped by the operator. Retry when ready.");
  const service = Object.create(ButlerAgentService.prototype) as ButlerAgentService;
  const internals = service as unknown as {
    piAuthPath: string;
    pendingChatCallbacks: Map<string, PendingChatCallback>;
    callbackReviewFailureCount: Map<string, number>;
    callbackReviewNotBefore: Map<string, number>;
    buildToolCatalog(): [];
    createOrRefreshSession(): Promise<void>;
    emit(event: string): boolean;
  };
  const dir = await mkdtemp(path.join(tmpdir(), "manor-settings-refresh-"));
  internals.piAuthPath = path.join(dir, "auth.json");
  internals.pendingChatCallbacks = new Map([[automatic.threadId, automatic], [operator.threadId, operator]]);
  internals.callbackReviewFailureCount = new Map([[automatic.threadId, 3], [operator.threadId, 1]]);
  internals.callbackReviewNotBefore = new Map([[automatic.threadId, 100], [operator.threadId, 200]]);
  internals.buildToolCatalog = () => [];
  internals.createOrRefreshSession = async () => {};
  internals.emit = () => true;

  await service.refreshModelSettings();

  assert.equal(automatic.reviewState, "blocked");
  assert.equal(operator.reviewState, "blocked");
  assert.deepEqual([...internals.callbackReviewFailureCount], [[automatic.threadId, 3], [operator.threadId, 1]]);
  assert.deepEqual([...internals.callbackReviewNotBefore], [[automatic.threadId, 100], [operator.threadId, 200]]);
});

test("pair shutdown drains active mutations and stops every callback review", async () => {
  const running = reviewCallback("running", "running");
  const queued = reviewCallback("queued", "queued");
  const service = Object.create(ButlerAgentService.prototype) as ButlerAgentService;
  let saves = 0;
  let schedulerDisposed = false;
  let storeListenerRemoved = false;
  const internals = service as unknown as {
    pendingChatCallbacks: Map<string, PendingChatCallback>;
    callbackReviewFailureCount: Map<string, number>;
    callbackReviewNotBefore: Map<string, number>;
    store: { getWorkerReport(threadId: string): { updatedAt: number }; off(event: string, listener: () => void): void };
    storeChangeHandler: () => void;
    callbackReviewScheduler: { dispose(): void };
    quiescing: boolean;
    saveCallbackState(): Promise<void>;
    emit(event: string): boolean;
  };
  internals.pendingChatCallbacks = new Map([[running.threadId, running], [queued.threadId, queued]]);
  internals.callbackReviewFailureCount = new Map([[running.threadId, 1], [queued.threadId, 2]]);
  internals.callbackReviewNotBefore = new Map([[running.threadId, 100], [queued.threadId, 200]]);
  internals.storeChangeHandler = () => undefined;
  internals.store = {
    getWorkerReport: () => ({ updatedAt: 42 }),
    off: () => { storeListenerRemoved = true; }
  };
  internals.callbackReviewScheduler = { dispose: () => { schedulerDisposed = true; } };
  internals.quiescing = false;
  internals.saveCallbackState = async () => { saves += 1; };
  internals.emit = () => true;

  let releaseMutation!: () => void;
  let markMutationStarted!: () => void;
  const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
  const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutation = runSerializedJobMutation(running.threadId, async () => {
    markMutationStarted();
    await mutationRelease;
  });
  await mutationStarted;
  let cancellationFinished = false;
  const cancellation = service.quiesceCallbackReviews().then(() => {
    cancellationFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancellationFinished, false);
  assert.equal(internals.quiescing, true);
  releaseMutation();
  await mutation;

  await cancellation;
  assert.equal(running.reviewState, "blocked");
  assert.equal(queued.reviewState, "blocked");
  assert.match(running.blockedCloseoutReason ?? "", /stopped by the operator/);
  assert.match(queued.blockedCloseoutReason ?? "", /stopped by the operator/);
  assert.equal(internals.callbackReviewFailureCount.size, 0);
  assert.equal(internals.callbackReviewNotBefore.size, 0);
  assert.equal(saves, 1);
  assert.equal(schedulerDisposed, true);
  assert.equal(storeListenerRemoved, true);
});

test("quiescing rejects late callback registration and reconciliation", async () => {
  const service = Object.create(ButlerAgentService.prototype) as ButlerAgentService;
  const internals = service as unknown as {
    quiescing: boolean;
    reconcilePendingChatCallbacks(): Promise<void>;
  };
  internals.quiescing = true;

  await assert.rejects(service.trackExternalWorkerDelegation("late-worker"), /session is closing/);
  await internals.reconcilePendingChatCallbacks();
});

test("Butler live thinking setter preserves exact supported level", () => {
  const calls: string[] = [];
  let emitted = false;
  const service = Object.create(ButlerAgentService.prototype) as ButlerAgentService & {
    session: { setThinkingLevel(level: string): void };
    lastError: string | null;
    emit(event: string): boolean;
  };
  service.session = {
    setThinkingLevel(level: string) {
      calls.push(level);
    }
  };
  service.lastError = "stale";
  service.emit = (event: string) => {
    emitted = event === "change";
    return true;
  };

  service.setThinkingLevel("minimal" as never);

  assert.deepEqual(calls, ["minimal"]);
  assert.equal(service.lastError, null);
  assert.equal(emitted, true);
});

test("Butler session sanitizer removes orphan tool results", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "review this" }] },
    { role: "toolResult", toolCallId: "call_missing|fc_missing", content: [{ type: "text", text: "stale output" }] },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_kept|fc_kept",
          name: "read_job",
          arguments: {}
        }
      ]
    },
    { role: "toolResult", toolCallId: "call_kept|fc_kept", content: [{ type: "text", text: "fresh output" }] }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);

  assert.equal(sanitized.changed, true);
  assert.deepEqual(
    sanitized.messages.map((message) => (message as { role?: string }).role),
    ["user", "assistant", "toolResult"]
  );
  assert.equal((sanitized.messages[2] as { toolCallId?: string }).toolCallId, "call_kept|fc_kept");
});

test("Butler session sanitizer bounds background prompts and tool results", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: `${BUTLER_BACKGROUND_PROMPT_PREFIX}\n${"background ".repeat(3000)}` }]
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_kept", name: "read_job", arguments: {} }]
    },
    {
      role: "toolResult",
      toolCallId: "call_kept",
      content: [{ type: "text", text: "tool output ".repeat(5000) }],
      details: {
        thread: { turns: Array.from({ length: 50 }, (_, index) => ({ id: `turn-${index}`, text: "large state".repeat(1000) })) },
        uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run." }]
      }
    }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);
  const background = sanitized.messages[0] as { content: Array<{ text?: string }> };
  const toolResult = sanitized.messages[2] as { content: Array<{ text?: string }>; details?: Record<string, unknown> };

  assert.equal(sanitized.changed, true);
  assert.ok((background.content[0]?.text?.length ?? 0) < 21_000);
  assert.match(background.content[0]?.text ?? "", /characters omitted/);
  assert.ok((toolResult.content[0]?.text?.length ?? 0) < 41_000);
  assert.match(toolResult.content[0]?.text ?? "", /characters omitted/);
  assert.deepEqual(Object.keys(toolResult.details ?? {}).sort(), ["omittedDetails", "uiEffects"]);
  assert.deepEqual((toolResult.details?.omittedDetails as { keys?: string[] }).keys, ["thread"]);
});

test("Butler session sanitizer removes ephemeral review turns from model context", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Keep this operator turn." }] },
    { role: "assistant", content: [{ type: "text", text: "Kept." }] },
    { role: "user", content: [{ type: "text", text: `${BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX}\nReview job 1.` }] },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read_job", arguments: {} }] },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "private review evidence" }] },
    { role: "assistant", content: [{ type: "text", text: "Private review decision." }] },
    { role: "user", content: [{ type: "text", text: "Keep the next operator turn too." }] }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);

  assert.equal(sanitized.changed, true);
  assert.deepEqual(sanitized.messages.map((message) => (message as { role: string }).role), ["user", "assistant", "user"]);
  assert.doesNotMatch(JSON.stringify(sanitized.messages), /private review/i);
});

test("tool result detail summarization preserves only ui effects and metadata", () => {
  const details = summarizeToolResultDetails({
    thread: { id: "thread-1", turns: ["large transcript"] },
    supervision: { butlerTurnsUsed: 1 },
    uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run." }]
  });

  assert.deepEqual(Object.keys(details ?? {}).sort(), ["omittedDetails", "uiEffects"]);
  assert.deepEqual((details?.omittedDetails as { keys?: string[] }).keys, ["thread", "supervision"]);
  assert.ok(Array.isArray(details?.uiEffects));
});

test("Butler message serialization skips empty user rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "" }], timestamp: 100 },
      { role: "user", content: [{ type: "text", text: "Review the current implementation" }], timestamp: 110 }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Review the current implementation");
});

test("Butler message serialization keeps attachment-only user rows visible", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "user-with-attachments",
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "file", name: "notes.txt" }
        ],
        timestamp: 100
      }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user-with-attachments");
  assert.equal(messages[0].text, "Attached 1 image, 1 file");
});

test("Butler compose settings accepts provider-qualified local model ids", async (t) => {
  const env = {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b"
  } as NodeJS.ProcessEnv;
  setActiveManorSettings(getActiveManorSettings(env));
  t.after(() => setActiveManorSettings(null));

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, env);

  const session = {
    model: null as { provider?: string | null; id?: string | null } | null,
    async setModel(model: { provider?: string | null; id?: string | null }) {
      session.model = model;
    },
    setThinkingLevel() {},
    getActiveToolNames() {
      return [];
    },
    setActiveToolsByName() {}
  };
  let emitted = false;

  await updateButlerComposeSettings({
    session,
    modelRegistry: registry,
    auth: { mode: "api" },
    lastError: "previous error",
    emit() {
      emitted = true;
      return true;
    }
  } as never, "ollama-local", "ollama-local/qwen3%3A8b", "medium");

  assert.equal(session.model?.provider, "ollama-local");
  assert.equal(session.model?.id, "qwen3:8b");
  assert.equal(emitted, true);
});

test("saved Ollama Cloud model becomes the active compose model after slow discovery", async (t) => {
  clearOllamaCloudModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).endsWith("/api/tags")) {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return Response.json({ models: [{ name: "glm-5.2" }] });
    }
    return Response.json({ capabilities: ["completion", "thinking"], model_info: {} });
  }) as typeof fetch;
  const env = {
    MANOR_OLLAMA_LOCAL_ENABLED: "0",
    MANOR_OLLAMA_CLOUD_ENABLED: "1",
    MANOR_OLLAMA_CLOUD_PROVIDER_ID: "ollama-cloud",
    MANOR_OLLAMA_CLOUD_BASE_URL: "https://ollama.example/v1",
    MANOR_OLLAMA_CLOUD_MODELS: "",
    MANOR_OLLAMA_WEB_TOOLS_BASE_URL: "https://ollama.example/api",
    OLLAMA_API_KEY: "test-key"
  } as NodeJS.ProcessEnv;
  const previousApiKey = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = "test-key";
  setActiveManorSettings(getActiveManorSettings(env));
  const dir = await mkdtemp(path.join(tmpdir(), "manor-slow-compose-"));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    clearOllamaCloudModelsCache();
    setActiveManorSettings(null);
    if (previousApiKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = previousApiKey;
    await rm(dir, { recursive: true, force: true });
  });

  const modelRegistry = await createManorModelRegistry(path.join(dir, "auth.json"), env, {
    preferredModelRef: "ollama-cloud/glm-5.2",
    recoveryTimeoutMs: 500
  });
  const session = {
    model: null as { provider?: string | null; id?: string | null } | null,
    async setModel(model: { provider?: string | null; id?: string | null }) { session.model = model; },
    setThinkingLevel() {},
    getActiveToolNames() { return []; },
    setActiveToolsByName() {}
  };
  const access = {
    session,
    modelRegistry,
    auth: { mode: "api" },
    lastError: "previous availability error",
    emit() { return true; }
  } as never;

  await updateButlerComposeSettings(access, "ollama-cloud", "ollama-cloud/glm-5.2", "high");

  assert.equal(session.model?.provider, "ollama-cloud");
  assert.equal(session.model?.id, "glm-5.2");
  assert.equal((access as { lastError: string | null }).lastError, null);
});

test("Butler defaults preserve current model when no default model is configured", async (t) => {
  const env = {
    MANOR_OLLAMA_LOCAL_ENABLED: "1",
    MANOR_OLLAMA_LOCAL_PROVIDER_ID: "ollama-local",
    MANOR_OLLAMA_LOCAL_BASE_URL: "http://ollama:11434/v1",
    MANOR_OLLAMA_LOCAL_MODELS: "qwen3:8b,llama3:8b"
  } as NodeJS.ProcessEnv;
  setActiveManorSettings(getActiveManorSettings(env));
  t.after(() => setActiveManorSettings(null));

  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  await registerManorProviders(registry, env);
  const existingModel = registry.getAvailable().find((model) => model.provider === "ollama-local" && model.id === "llama3:8b");
  assert.ok(existingModel);
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  let thinkingLevel: string | null = null;
  const session = {
    model: existingModel,
    async setModel(model: { provider: string; id: string }) {
      setModelCalls.push({ provider: model.provider, id: model.id });
      session.model = model as never;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    }
  };

  await applyManagedButlerDefaults({
    session,
    modelRegistry: registry,
    auth: { mode: "api" }
  } as never);

  assert.deepEqual(setModelCalls, []);
  assert.equal(session.model.id, "llama3:8b");
  assert.equal(thinkingLevel, "medium");
});

test("Butler defaults use off when a reasoning model has no selectable thinking variants", async () => {
  const noVariantModel = {
    id: "qwen3.7-max",
    name: "Qwen 3.7 Max",
    provider: "opencode-go",
    baseUrl: "https://opencode.example/zen/go/v1",
    api: "openai-completions",
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 32_768,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null
    },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  let thinkingLevel: string | null = null;
  const session = {
    model: noVariantModel,
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    }
  };

  await applyManagedButlerDefaults({
    session,
    modelRegistry: {
      getAvailable() {
        return [noVariantModel];
      }
    },
    auth: { mode: "api" }
  } as never);

  assert.equal(thinkingLevel, "off");
});

test("Butler message serialization skips internal assistant tool-only rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking state" },
          { type: "toolCall", id: "call-1", name: "read_job", arguments: {} }
        ],
        timestamp: 100
      },
      {
        role: "assistant",
        content: [{ type: "function_call", name: "list_jobs", arguments: "{}" }],
        timestamp: 110
      }
    ]
  } as never);

  assert.equal(contentAttachmentSummary([{ type: "thinking" }, { type: "toolCall", name: "read_job" }]), "");
  assert.deepEqual(messages, []);
});

test("Butler message serialization skips assistant attachment summary text rows", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Attached 2 attachments" }], timestamp: 100 },
      { role: "assistant", content: [{ type: "text", text: "Attached 1 attachment" }], timestamp: 110 },
      { role: "assistant", content: [{ type: "text", text: "Reviewed the worker reply." }], timestamp: 120 }
    ]
  } as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Reviewed the worker reply.");
});

test("Butler message serialization hides background prompts with attachments", () => {
  const messages = serializeMessages({
    sessionId: "session-1",
    messages: [
      {
        role: "user-with-attachments",
        content: [
          { type: "text", text: "[[BUTLER_BACKGROUND]]\nprivate review" },
          { type: "image", data: "abc", mimeType: "image/png" }
        ],
        timestamp: 100
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hidden internal reply" }],
        timestamp: 110
      },
      {
        role: "user",
        content: [{ type: "text", text: "Visible prompt" }],
        timestamp: 120
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Visible reply" }],
        timestamp: 130
      }
    ]
  } as never);

  assert.deepEqual(messages.map((message) => message.text), ["Visible prompt", "Visible reply"]);
});

test("server-owned pending operator prompts are visible before Pi commits them", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "Review the current implementation\n\nStored reference files:\n- internal", "Review the current implementation");

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Review the current implementation\n\nStored reference files:\n- internal");
  assert.equal(messages[0].displayText, "Review the current implementation");
  assert.equal(messages[0].pending, true);
  assert.equal(access.pendingOperatorMessageRevision, 1);

  removeCommittedPendingOperatorPrompt(access as never, "Review the current implementation\n\nStored reference files:\n- internal", Date.now() + 100);
  assert.equal(access.pendingOperatorMessages.length, 0);
  assert.equal(access.pendingOperatorMessageRevision, 2);
});

test("provider user echoes do not duplicate visible pending operator prompts", () => {
  const access = pendingAccess();
  const id = registerPendingOperatorPrompt(access as never, "Make it store todos locally");
  access.pendingOperatorMessages[0].at = 100;
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Make it store todos locally" }], timestamp: 110 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, id);
  assert.equal(messages[0].pending, true);
  assert.equal(messages[0].text, "Make it store todos locally");
});

test("server-owned pending operator prompts settle one committed user row at a time", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "same prompt");
  registerPendingOperatorPrompt(access as never, "same prompt");

  removeCommittedPendingOperatorPrompt(access as never, "same prompt", Date.now() + 100);
  assert.equal(access.pendingOperatorMessages.length, 1);
  assert.equal(access.pendingOperatorMessages[0].text, "same prompt");

  removeCommittedPendingOperatorPrompt(access as never, "same prompt", Date.now() + 200);
  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned pending operator prompts settle when providers normalize user text", () => {
  const access = pendingAccess();
  registerPendingOperatorPrompt(access as never, "original prompt");

  removeCommittedPendingOperatorPrompt(access as never, "normalized prompt", Date.now() + 100);

  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned pending operator prompts commit when providers omit user echoes", () => {
  const access = pendingAccess();
  const id = registerPendingOperatorPrompt(access as never, "provider omitted this echo", "provider omitted this echo");

  commitPendingOperatorPrompt(access as never, id);

  assert.equal(access.pendingOperatorMessages.length, 1);
  assert.equal(access.pendingOperatorMessages[0].pending, undefined);
  assert.equal(getVisibleButlerMessages(access as never)[0].text, "provider omitted this echo");
});

test("server-owned committed prompts defer to provider-stored user history", () => {
  const access = pendingAccess();
  const id = registerPendingOperatorPrompt(access as never, "Original prompt");
  access.pendingOperatorMessages[0].at = 100;
  commitPendingOperatorPrompt(access as never, id);
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Normalized prompt" }], timestamp: 110 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-0");
  assert.equal(messages[0].text, "Normalized prompt");
});

test("durable operator prompts remain visible after provider compaction drops user rows", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-user-1",
    role: "user",
    text: "Please review the latest preview",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Review complete." }], timestamp: 120 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[0].text, "Please review the latest preview");
});

test("durable provider replies remain visible after provider compaction drops assistant rows", () => {
  const access = pendingAccess();
  access.operatorMessages.push(
    {
      id: "operator-user-1",
      role: "user",
      text: "Are you learning from my feedback?",
      at: 100,
      taskDurationMs: null,
      kind: "message"
    },
    {
      id: "operator-session-reply-1",
      role: "assistant",
      text: "Yes. I am carrying that feedback forward.",
      at: 120,
      taskDurationMs: null,
      kind: "message"
    }
  );

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.text), ["Are you learning from my feedback?", "Yes. I am carrying that feedback forward."]);
});

test("provider history suppresses duplicate durable provider replies", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-session-reply-1",
    role: "assistant",
    text: "I am carrying that feedback forward.",
    at: 120,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "I am carrying that feedback forward." }], timestamp: 121 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-0");
});

test("delegation acknowledgement inherits the hidden provider reply trace", () => {
  const traceItem = {
    id: "tool-1",
    type: "dynamic_tool_call" as const,
    status: "completed" as const,
    title: "delegate_to_worker",
    text: "Delegated to Worker",
    at: 110,
    completedAt: 119
  };
  const messages = collapseCallbackDuplicateMessages([{
    id: "delegation-ack-worker-1",
    role: "assistant",
    text: "Accepted. I delegated this to a Worker.",
    at: 120,
    taskDurationMs: null,
    kind: "message"
  }, {
    id: "operator-session-reply-1",
    role: "assistant",
    text: "The Worker is running.",
    at: 121,
    taskDurationMs: null,
    kind: "message",
    trace: [traceItem],
    traceMeta: {
      turnId: "turn-1",
      startedAt: 100,
      completedAt: 121,
      items: [traceItem]
    }
  }]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.trace, [traceItem]);
  assert.equal(messages[0]?.traceMeta?.turnId, "turn-1");
});

test("completed Butler activity attaches directly to a delegation acknowledgement", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "delegation-ack-worker-1",
    role: "assistant",
    text: "Accepted. I delegated this to a Worker.",
    at: 120,
    taskDurationMs: null,
    kind: "message"
  });
  access.activityTurns = [{
    id: "turn-1",
    status: "completed",
    startedAt: 100,
    completedAt: 130,
    detail: null,
    items: [{
      id: "thinking-1",
      kind: "thinking",
      status: "completed",
      title: "Thinking",
      text: "Delegating the task.",
      at: 105,
      updatedAt: 125,
      contentIndex: null,
      toolCallId: null
    }]
  }];

  assert.equal(attachCompletedActivityTraceToDelegationAcknowledgement(access as never), true);
  assert.equal(access.operatorMessages[0]?.trace?.[0]?.text, "Delegating the task.");
  assert.equal(access.operatorMessages[0]?.traceMeta?.turnId, "turn-1");
});

test("provider history retains the durable trace when suppressing a duplicate reply", () => {
  const access = pendingAccess();
  const traceItem = {
    id: "tool-1",
    type: "dynamic_tool_call" as const,
    status: "failed" as const,
    title: "inspect_preview",
    text: "Preview container exited with code 1.",
    at: 110,
    completedAt: 119
  };
  access.operatorMessages.push({
    id: "operator-session-reply-1",
    role: "assistant",
    text: "The preview failed.",
    at: 120,
    taskDurationMs: null,
    kind: "message",
    trace: [traceItem],
    traceMeta: {
      turnId: "turn-1",
      startedAt: 100,
      completedAt: 120,
      items: [traceItem]
    }
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "The preview failed." }], timestamp: 121 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "message-0");
  assert.deepEqual(messages[0].trace, [traceItem]);
  assert.equal(messages[0].traceMeta?.turnId, "turn-1");
  assert.deepEqual(messages[0].traceMeta?.items, [traceItem]);
});

test("provider user history suppresses duplicate durable operator prompts", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-user-1",
    role: "user",
    text: "Original prompt",
    displayText: "What do you see?",
    attachments: [{ id: "image-1", kind: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 20, url: "/api/images/image-1" }],
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Normalized prompt" }], timestamp: 110 },
      { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 120 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.id), ["message-0", "message-1"]);
  assert.deepEqual(messages.map((message) => message.text), ["Normalized prompt", "Done."]);
  assert.equal(messages[0]?.displayText, "What do you see?");
  assert.deepEqual(messages[0]?.attachments, access.operatorMessages[0]?.attachments);
});

test("provider compaction does not move earlier attachments onto a retained later prompt", () => {
  const access = pendingAccess();
  access.operatorMessages.push(
    { id: "operator-a", role: "user", text: "internal A", displayText: "Prompt A", attachments: [{ id: "image-a", kind: "image", name: "a.png", mimeType: "image/png", sizeBytes: 10, url: "/api/images/image-a" }], at: 100, taskDurationMs: null, kind: "message" },
    { id: "operator-b", role: "user", text: "internal B", displayText: "Prompt B", attachments: [{ id: "image-b", kind: "image", name: "b.png", mimeType: "image/png", sizeBytes: 10, url: "/api/images/image-b" }], at: 110, taskDurationMs: null, kind: "message" }
  );
  access.session = { sessionId: "session-1", messages: [{ role: "user", content: [{ type: "text", text: "internal B\n\nThe current model cannot receive image bytes." }], timestamp: 115 }] };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.displayText), ["Prompt A", "Prompt B"]);
  assert.deepEqual(messages.map((message) => message.attachments?.[0]?.id), ["image-a", "image-b"]);
});

test("provider user history suppresses duplicate session-backed user prompts", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "operator-session-message-73",
    role: "user",
    text: "Make it store todos locally",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Make it store todos locally" }], timestamp: 100 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.id), ["message-0"]);
});

test("visible user messages collapse committed pending and provider echo duplicates", () => {
  const access = pendingAccess();
  access.operatorMessages.push(
    {
      id: "pending-operator-1",
      role: "user",
      text: "Make it store todos locally",
      at: 100,
      taskDurationMs: null,
      kind: "message"
    },
    {
      id: "operator-session-message-73",
      role: "user",
      text: "Make it store todos locally",
      at: 110,
      taskDurationMs: null,
      kind: "message"
    }
  );
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "Make it store todos locally" }], timestamp: 110 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.deepEqual(messages.map((message) => message.id), ["message-0"]);
});

test("pending operator prompts override durable prompt rows with the same id", () => {
  const access = pendingAccess();
  access.operatorMessages.push({
    id: "pending-operator-1",
    role: "user",
    text: "Queued prompt",
    at: 100,
    taskDurationMs: null,
    kind: "message"
  });
  access.pendingOperatorMessages.push({
    id: "pending-operator-1",
    role: "user",
    text: "Queued prompt",
    at: 100,
    taskDurationMs: null,
    kind: "message",
    pending: true
  });

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].pending, true);
});

test("provider-stored user history suppresses only one synthetic prompt", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  access.pendingOperatorMessages[0].at = 100;
  access.pendingOperatorMessages[1].at = 110;
  commitPendingOperatorPrompt(access as never, firstId);
  commitPendingOperatorPrompt(access as never, secondId);
  access.session = {
    sessionId: "session-1",
    messages: [
      { role: "user", content: [{ type: "text", text: "provider stored one prompt" }], timestamp: 105 }
    ]
  };

  const messages = getVisibleButlerMessages(access as never);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.text), ["provider stored one prompt", "second prompt"]);
});

test("server-owned pending operator prompts clear by id or pending-only sweep", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  commitPendingOperatorPrompt(access as never, secondId);

  removePendingOperatorPrompt(access as never, firstId);
  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["second prompt"]);

  clearPendingOperatorPrompts(access as never);
  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["second prompt"]);

  clearPendingOperatorPrompts(access as never, { includeCommitted: true });
  assert.equal(access.pendingOperatorMessages.length, 0);
});

test("server-owned operator prompts trim by timestamp", () => {
  const access = pendingAccess();
  const firstId = registerPendingOperatorPrompt(access as never, "first prompt");
  const secondId = registerPendingOperatorPrompt(access as never, "second prompt");
  access.pendingOperatorMessages[0].at = 100;
  access.pendingOperatorMessages[1].at = 200;
  commitPendingOperatorPrompt(access as never, firstId);
  commitPendingOperatorPrompt(access as never, secondId);

  keepPendingOperatorPromptsBefore(access as never, 200);

  assert.deepEqual(access.pendingOperatorMessages.map((message) => message.text), ["first prompt"]);
});

test("startup backfill restores operator user prompts from persisted session logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "one", timestamp: "2026-06-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Show this prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply", timestamp: "2026-06-15T10:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Visible reply" }] } }),
      JSON.stringify({ type: "message", id: "internal", timestamp: "2026-06-15T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "[[BUTLER_BACKGROUND]]\nHide this" }] } }),
      JSON.stringify({ type: "message", id: "assistant", timestamp: "2026-06-15T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hidden reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Show this prompt", "Visible reply"]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
});

test("live prompt sync restores provider assistant replies after queued turns complete", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-live-sync-"));
  const at = Date.parse("2026-06-28T01:11:50.227Z");
  const messages = [{
    id: "pending-operator-1782609110224-0",
    role: "user",
    text: "Smoke test only. Reply with exactly: Butler smoke ok. Do not delegate.",
    at,
    taskDurationMs: null,
    kind: "message" as const
  }];
  let saved = 0;
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "user", timestamp: "2026-06-28T01:11:50.230Z", message: { role: "user", content: [{ type: "text", text: messages[0]!.text }], timestamp: at } }),
      JSON.stringify({
        type: "message",
        id: "assistant",
        timestamp: "2026-06-28T01:11:59.145Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning text that should stay out of chat." },
            { type: "text", text: "Butler smoke ok. Do not delegate." }
          ],
          timestamp: Date.parse("2026-06-28T01:11:52.531Z")
        }
      })
    ].join("\n"),
    "utf8"
  );

  const changed = await syncOperatorMessagesFromSessionFiles({
    operatorMessages: messages,
    sessionDir: dir,
    async saveOperatorMessageState() {
      saved += 1;
    }
  });

  assert.equal(changed, true);
  assert.equal(saved, 1);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.text), [
    "Smoke test only. Reply with exactly: Butler smoke ok. Do not delegate.",
    "Butler smoke ok. Do not delegate."
  ]);
});

test("startup backfill ignores internal tool-only assistant turns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({
        type: "message",
        id: "tool-only",
        timestamp: "2026-06-15T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting" },
            { type: "toolCall", id: "call-1", name: "list_jobs", arguments: {} }
          ]
        }
      }),
      JSON.stringify({
        type: "message",
        id: "visible",
        timestamp: "2026-06-15T10:00:10.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Visible reply" }] }
      })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Visible reply"]);
});

test("operator history normalization removes stale leaked attachment summaries", () => {
  const messages = [
    {
      id: "operator-session-message-216",
      role: "assistant",
      text: "Attached 2 attachments",
      at: 100,
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-user-visible",
      role: "user",
      text: "Visible prompt",
      at: 200,
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-session-visible",
      role: "assistant",
      text: "Visible reply",
      at: 210,
      taskDurationMs: null,
      kind: "message" as const
    }
  ];

  const changed = normalizeOperatorMessages(messages);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), ["Visible prompt", "Visible reply"]);
});

test("startup backfill restores older coherent turns before pruning", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [{
    id: "operator-session-latest",
    role: "assistant",
    text: "Later durable assistant row",
    at: Date.parse("2026-06-15T14:00:00.000Z"),
    taskDurationMs: null,
    kind: "message" as const
  }];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "prompt", timestamp: "2026-06-15T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Recover this older prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply", timestamp: "2026-06-15T09:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Recover this older reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.text), [
    "Recover this older prompt",
    "Recover this older reply",
    "Later durable assistant row"
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
});

test("startup backfill repairs assistant-only durable history from raw session turns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-butler-session-backfill-"));
  const messages = [
    {
      id: "operator-session-reply-one",
      role: "assistant",
      text: "First recovered reply",
      at: Date.parse("2026-06-15T09:00:20.000Z"),
      taskDurationMs: null,
      kind: "message" as const
    },
    {
      id: "operator-session-reply-two",
      role: "assistant",
      text: "Second recovered reply",
      at: Date.parse("2026-06-15T09:01:20.000Z"),
      taskDurationMs: null,
      kind: "message" as const
    }
  ];
  await writeFile(
    path.join(dir, "session.jsonl"),
    [
      JSON.stringify({ type: "message", id: "prompt-one", timestamp: "2026-06-15T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "First missing prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply-one", timestamp: "2026-06-15T09:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "First recovered reply" }] } }),
      JSON.stringify({ type: "message", id: "prompt-two", timestamp: "2026-06-15T09:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "Second missing prompt" }] } }),
      JSON.stringify({ type: "message", id: "reply-two", timestamp: "2026-06-15T09:01:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "Second recovered reply" }] } })
    ].join("\n"),
    "utf8"
  );

  const changed = await backfillOperatorMessagesFromSessionFiles(messages, dir);

  assert.equal(changed, true);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(messages.map((message) => message.text), [
    "First missing prompt",
    "First recovered reply",
    "Second missing prompt",
    "Second recovered reply"
  ]);
});

test("operator history normalization drops old prompt-only rows before coherent turns", () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    upsertProviderBackedOperatorMessage(messages, `operator-user-old-${index}`, `orphan prompt ${index}`, 1000 + index, "user");
  }

  for (let index = 0; index < 12; index += 1) {
    const at = 10_000_000 + index * 10_000;
    upsertProviderBackedOperatorMessage(messages, `operator-user-new-${index}`, `prompt ${index}`, at, "user");
    upsertOperatorMessage(messages, `reply-${index}`, `reply ${index}`, at + 1000);
  }

  assert.equal(messages.some((message) => message.text.startsWith("orphan prompt")), false);
  assert.deepEqual(messages.slice(0, 2).map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages.at(-1)?.text, "reply 11");
});

test("operator history normalization drops old provider replies with no recovered prompt", () => {
  const messages = [];
  for (let index = 0; index < 8; index += 1) {
    upsertProviderBackedOperatorMessage(messages, `operator-session-old-${index}`, `old assistant ${index}`, 1000 + index, "assistant");
  }
  upsertProviderBackedOperatorMessage(messages, "operator-user-current", "current prompt", 10_000_000, "user");
  upsertProviderBackedOperatorMessage(messages, "operator-session-current", "current reply", 10_000_100, "assistant");

  assert.deepEqual(messages.map((message) => message.text), ["current prompt", "current reply"]);
});

test("Butler stop requests advance a sequence for steer handoff checks", async () => {
  const access = pendingAccess();

  await stopButlerPrompt(access as never);
  assert.equal(access.stopRequestSequence, 1);

  await stopButlerPrompt(access as never);
  assert.equal(access.stopRequestSequence, 2);
});

test("Butler stop guard blocks stops after a steer handoff before prompt execution", async () => {
  const access = pendingAccess();

  await stopButlerPrompt(access as never, { clearPendingOperatorMessages: false });
  const acceptedSteerStop = access.stopRequestSequence;
  assert.equal(hasBlockingStopRequest(access as never, acceptedSteerStop), false);

  await stopButlerPrompt(access as never);
  assert.equal(hasBlockingStopRequest(access as never, acceptedSteerStop), true);
});

test("Butler session sanitizer matches tool results by base call id", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_base|fc_detail",
          name: "read_job",
          arguments: {}
        }
      ]
    },
    { role: "toolResult", toolCallId: "call_base", content: [{ type: "text", text: "output" }] }
  ];

  const sanitized = sanitizeHistoryMessages(messages as never);

  assert.equal(sanitized.changed, false);
  assert.equal(sanitized.messages.length, 2);
});

test("Butler failed retry cleanup removes the failed assistant and prompt", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "previous ok" }] },
    { role: "user", content: [{ type: "text", text: "background review" }] },
    { role: "assistant", stopReason: "error", errorMessage: "No tool call found for function call output with call_id call_missing." }
  ];
  const access = {
    session: {
      messages,
      agent: {
        state: {
          messages
        }
      }
    }
  };

  dropTrailingFailedButlerTurns(access as never);

  assert.deepEqual(access.session.agent.state.messages, [{ role: "assistant", content: [{ type: "text", text: "previous ok" }] }]);
});
