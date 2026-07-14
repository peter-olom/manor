import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PairSessionManager } from "../../src/server/pair-session-manager.js";
import { PairStore } from "../../src/server/pair-store.js";
import { ButlerStateStore } from "../../src/server/state-store.js";
import type { ButlerMessagePageView, ButlerMessageView, ModelOption, ReasoningEffort } from "../../src/server/types.js";
import type { SessionTitleGenerator } from "../../src/server/session-title-generator.js";

class FakeButlerService extends EventEmitter {
  messages: ButlerMessageView[] = [];
  refreshCount = 0;
  resourceReloadCount = 0;
  startCount = 0;
  pending = false;
  trackedExternalThreads: string[] = [];
  handoffs: Array<{ sourceThreadId: string; harness: string; model: string; effort: string | null; butlerThreadId?: string | null; cwd?: string | null }> = [];
  handoffDelayMs = 0;
  concurrentHandoffs = 0;
  maxConcurrentHandoffs = 0;
  retryReviewCount = 0;
  cancelReviewCount = 0;
  lifecycleEvents: string[] = [];
  stopCount = 0;
  disposeCount = 0;
  activityTurns: Array<Record<string, unknown>> = [];
  callbacks: Array<Record<string, unknown>> = [];
  compose: {
    provider: string | null;
    model: string | null;
    thinkingLevel: string;
    availableThinkingLevels: string[];
    availableModels: ModelOption[];
  } = {
    provider: "openai",
    model: "gpt-test",
    thinkingLevel: "medium",
    availableThinkingLevels: ["low", "medium", "high", "xhigh"],
    availableModels: [{
      id: "gpt-test",
      label: "GPT Test",
      provider: "openai",
      supportsReasoning: true,
      supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium"
    }]
  };
  nextCompose: FakeButlerService["compose"] | null = null;

  async start(): Promise<void> { this.startCount += 1; }

  dispose(): void { this.disposeCount += 1; this.lifecycleEvents.push("dispose"); }

  async refreshModelSettings(): Promise<void> {
    this.refreshCount += 1;
    this.emit("change");
  }

  async reloadResources(): Promise<void> { this.resourceReloadCount += 1; }

  listComposerCommands(): [] { return []; }

  async stopPrompt(): Promise<void> { this.stopCount += 1; this.lifecycleEvents.push("stop-prompt"); }

  ensureExternalWorkerDelegation(threadId: string): void {
    if (!this.trackedExternalThreads.includes(threadId)) this.trackedExternalThreads.push(threadId);
  }

  async retryBlockedCallbackReviews(): Promise<boolean> {
    this.retryReviewCount += 1;
    return true;
  }

  async cancelCallbackReview(): Promise<boolean> {
    this.cancelReviewCount += 1;
    this.lifecycleEvents.push("cancel-review");
    return true;
  }

  async quiesceCallbackReviews(): Promise<void> {
    await this.cancelCallbackReview();
  }

  async handoffWorker(input: { sourceThreadId: string; harness: string; model: string; effort: string | null; butlerThreadId?: string | null; cwd?: string | null }): Promise<void> {
    this.concurrentHandoffs += 1;
    this.maxConcurrentHandoffs = Math.max(this.maxConcurrentHandoffs, this.concurrentHandoffs);
    try {
      this.handoffs.push(input);
      if (this.handoffDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.handoffDelayMs));
    } finally {
      this.concurrentHandoffs -= 1;
    }
  }

  setThinkingLevel(_level: never): void {}

  async updateComposeSettings(provider: string, model: string, thinkingLevel: string): Promise<void> {
    this.compose = this.nextCompose ?? {
      ...this.compose,
      provider,
      model,
      thinkingLevel
    };
    this.nextCompose = null;
  }

  prompt(text: string): void {
    this.messages.push({
      id: `message-${this.messages.length + 1}`,
      role: "user",
      text,
      at: Date.now(),
      taskDurationMs: null,
      kind: "message"
    });
    this.emit("change");
  }

  getMessagePage(_before: number | null, _limit: number): ButlerMessagePageView {
    return {
      messages: [...this.messages],
      startIndex: 0,
      endIndex: this.messages.length,
      totalCount: this.messages.length,
      hasMore: false
    };
  }

  getLiveSnapshot(): Record<string, unknown> {
    return { messages: this.messages, messageCount: this.messages.length, activityTurns: this.activityTurns };
  }

  getShellSnapshot(): Record<string, unknown> {
    return {
      sessionId: "fake-session",
      ready: true,
      pending: this.pending,
      isStreaming: false,
      lastError: null,
      compose: this.compose,
      supervision: { callbacks: this.callbacks }
    };
  }
}

async function createManager(generator: SessionTitleGenerator | null = null, onCreateService?: (options: unknown) => void, runtime?: { workerModels?: ModelOption[]; butlerSkills?: Array<{ id: string; name: string; description: string; invocation: string }>; skillsByEnvironment?: Partial<Record<"butler-pi" | "worker-pi" | "worker-codex", Array<{ id: string; name: string; description: string; invocation: string }>>>; validateWorkspace?: (cwd: string) => Promise<string> }): Promise<{
  manager: PairSessionManager;
  pairStore: PairStore;
  service: FakeButlerService;
  store: ButlerStateStore;
  codexUpdates: Array<{ model: string; effort: ReasoningEffort | null }>;
  threadEffortUpdates: Array<{ threadId: string; effort: ReasoningEffort }>;
  codexComposerCalls: string[];
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-session-test-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const pairStore = new PairStore(path.join(dir, "pairs.json"), store);
  await pairStore.load();
  const service = new FakeButlerService();
  const codexUpdates: Array<{ model: string; effort: ReasoningEffort | null }> = [];
  const threadEffortUpdates: Array<{ threadId: string; effort: ReasoningEffort }> = [];
  const codexComposerCalls: string[] = [];
  const workerModels = runtime?.workerModels ?? [];
  const manager = new PairSessionManager({
    pairStore,
    store,
    codexClient: {
      getConnectionState: () => ({ connected: true, lastError: null, compose: { model: null, effort: null, availableModels: workerModels } }),
      updateComposeSettings: async (model: string, effort: ReasoningEffort | null) => {
        codexUpdates.push({ model, effort });
      },
      updateThreadReasoningEffort: async (threadId: string, effort: ReasoningEffort) => {
        threadEffortUpdates.push({ threadId, effort });
      },
      listComposerSuggestions: async () => {
        codexComposerCalls.push("called");
        return [{ id: "app:figma", kind: "app", label: "Figma", detail: null, insertText: "$figma", inputItem: { type: "mention", name: "Figma", path: "app://figma" } }];
      }
    },
    hostController: {},
    runtimeBroker: {},
    serviceTemplateRegistry: {},
    imageStore: { resolveViews: () => [] },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    skillsService: {
      list: async (environment: "butler-pi" | "worker-pi" | "worker-codex") => runtime?.skillsByEnvironment?.[environment] ?? (environment === "butler-pi" ? runtime?.butlerSkills ?? [] : []),
      resolveInputItem: async (_environment: string, id: string) => ({ type: "skill", name: id === "skill-review" ? "review" : "unknown", path: `/skills/${id}/SKILL.md` })
    },
    extensionUiBroker: {},
    piAuthPath: path.join(dir, "pi-auth.json"),
    codexAuthPath: path.join(dir, "codex-auth.json"),
    codexConfigDir: dir,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    sessionRootDir: path.join(dir, "sessions"),
    artifactsDir: path.join(dir, "artifacts"),
    sessionTitleGenerator: generator,
    validateWorkspace: runtime?.validateWorkspace ?? (async (cwd: string) => cwd),
    listWorkspaceProjects: async () => [],
    createButlerService: (serviceOptions: unknown) => {
      onCreateService?.(serviceOptions);
      return service as never;
    }
  } as never);
  return { manager, pairStore, service, store, codexUpdates, threadEffortUpdates, codexComposerCalls };
}

test("pair Butler services receive a pair-scoped runtime thread id", async () => {
  const runtimeThreadIds: unknown[] = [];
  const { manager } = await createManager(null, (options) => {
    runtimeThreadIds.push((options as { runtimeThreadId?: unknown }).runtimeThreadId);
  });

  const first = await manager.createPair();
  const second = await manager.createPair();

  assert.deepEqual(runtimeThreadIds, [`butler:${first.id}`, `butler:${second.id}`]);
});

test("skill mutations schedule resource reloads for active pair Butler sessions", async () => {
  const { manager, service } = await createManager();
  await manager.createPair();

  manager.scheduleButlerSkillsReload();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.resourceReloadCount, 1);
});

test("pair Butler services expose the complete persisted Worker handoff lineage", async () => {
  let getWorkerDefaults: (() => { runtimeOwnerThreadIds?: string[] }) | undefined;
  const { manager, pairStore } = await createManager(null, (options) => {
    getWorkerDefaults = (options as { getWorkerDefaults?: () => { runtimeOwnerThreadIds?: string[] } }).getWorkerDefaults;
  });
  const pair = await manager.createPair();
  pairStore.attachWorker(pair.id, { threadId: "thread-first", runtime: "openai" });
  pairStore.attachWorker(pair.id, { threadId: "thread-second", runtime: "pi-rpc", replacesThreadId: "thread-first" });
  pairStore.attachWorker(pair.id, { threadId: "thread-third", runtime: "openai", replacesThreadId: "thread-second" });

  assert.deepEqual(getWorkerDefaults?.().runtimeOwnerThreadIds, ["thread-third", "thread-second", "thread-first"]);
});

test("pair detail exposes active Butler tools and adversarial review progress", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair();
  service.activityTurns = [{
    id: "activity-1",
    status: "active",
    startedAt: 100,
    completedAt: null,
    items: [{ id: "tool-1", kind: "tool", status: "error", title: "inspect_preview", text: "container exited 1", at: 100, updatedAt: 200, contentIndex: null, toolCallId: "call-1" }]
  }];
  service.callbacks = [{
    threadId: "worker-1",
    callbackState: "received_worker_callback",
    owesOperatorReply: true,
    reviewState: "running",
    reviewStage: "reviewing_changes",
    reviewAttempt: 2,
    reviewStartedAt: 100,
    reviewDeadlineAt: 120_100,
    reviewNextAttemptAt: null,
    reviewLastActivityAt: 200,
    reviewLastActivity: "Failed inspect_preview: container exited 1",
    reviewLastTool: "inspect_preview",
    reviewLastError: "container exited 1",
    reviewModelProvider: "ollama-cloud",
    reviewModelId: "glm-5.2",
    reviewReasoningLevel: "high"
  }];

  const detail = await manager.getPairDetail(pair.id, null, 120);

  assert.deepEqual(detail?.butlerActivity.map((item) => ({ type: item.type, status: item.status, text: item.text })), [{
    type: "dynamic_tool_call",
    status: "failed",
    text: "container exited 1"
  }]);
  assert.equal(detail?.butlerActivityOutcome?.status, "active");
  assert.equal(detail?.review?.stage, "reviewing_changes");
  assert.equal(detail?.review?.attempt, 2);
  assert.equal(detail?.review?.lastTool, "inspect_preview");
  assert.equal(detail?.review?.modelId, "glm-5.2");
});

test("pair detail retains completed Butler activity when no assistant message represents it", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair();
  service.activityTurns = [{
    id: "activity-1",
    status: "completed",
    startedAt: 100,
    completedAt: 200,
    items: [{ id: "tool-1", kind: "tool", status: "completed", title: "ask_operator", text: "Question card posted", at: 100, updatedAt: 200, contentIndex: null, toolCallId: "call-1" }]
  }];

  const detail = await manager.getPairDetail(pair.id, null, 120);

  assert.deepEqual(detail?.butlerActivity.map((item) => ({ title: item.title, status: item.status, text: item.text })), [{
    title: "ask_operator",
    status: "completed",
    text: "Question card posted"
  }]);
  assert.equal(detail?.butlerActivityOutcome?.status, "completed");
});

test("pair detail retains an immediate Butler failure with no activity items", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair();
  service.activityTurns = [{
    id: "activity-failed",
    status: "failed",
    startedAt: 100,
    completedAt: 120,
    detail: "Provider connection closed before streaming.",
    items: []
  }];

  const detail = await manager.getPairDetail(pair.id, null, 120);

  assert.deepEqual(detail?.butlerActivity, []);
  assert.deepEqual(detail?.butlerActivityOutcome, {
    status: "failed",
    startedAt: 100,
    completedAt: 120,
    detail: "Provider connection closed before streaming."
  });
});

test("sendOperatorMessage starts automatic title generation for the first text prompt", async () => {
  const calls: string[] = [];
  const { manager, pairStore } = await createManager({
    async generateTitle(input) {
      calls.push(input.firstUserPrompt);
      return "Checkout retry review";
    }
  });
  const pair = await manager.createPair();

  await manager.sendOperatorMessage({
    pairId: pair.id,
    text: "Please review checkout retry failures.",
    imageReferenceIds: [],
    fileReferenceIds: []
  });
  await Promise.resolve();

  assert.deepEqual(calls, ["Please review checkout retry failures."]);
  assert.equal(pairStore.getPair(pair.id)?.title, "Checkout retry review");
});

test("selected Butler skills use Pi native skill expansion", async () => {
  const { manager, service } = await createManager(null, undefined, { butlerSkills: [{ id: "skill-review", name: "review", description: "Review changes", invocation: "/skill:review" }] });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({
    pairId: pair.id,
    text: "Check the release",
    imageReferenceIds: [],
    fileReferenceIds: [],
    inputItems: [{ type: "skill", name: "review", id: "skill-review", environment: "butler-pi" }]
  });
  assert.match(service.messages.at(-1)?.text ?? "", /^\/skill:review\n\nMANOR-WIDE SKILL ROUTING/);
  assert.match(service.messages.at(-1)?.text ?? "", /Check the release$/);
  assert.doesNotMatch(service.messages.at(-1)?.text ?? "", /Selected composer context:[\s\S]*skill:/);
});

test("Butler accepts one native skill and ignores app mentions", async () => {
  const { manager, service } = await createManager(null, undefined, { butlerSkills: [{ id: "skill-review", name: "review", description: "Review changes", invocation: "/skill:review" }] });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({
    pairId: pair.id,
    text: "Check the release",
    imageReferenceIds: [],
    fileReferenceIds: [],
    inputItems: [
      { type: "skill", name: "review", id: "skill-review", environment: "butler-pi" },
      { type: "skill", name: "other", id: "skill-other", environment: "butler-pi" },
      { type: "mention", name: "Figma", path: "app://figma" }
    ]
  });
  const prompt = service.messages.at(-1)?.text ?? "";
  assert.match(prompt, /^\/skill:review\n\nMANOR-WIDE SKILL ROUTING/);
  assert.match(prompt, /Check the release$/);
  assert.doesNotMatch(prompt, /skill:other|Figma|app:\/\//);
});

test("Butler dollar suggestions list skills without querying transport apps", async () => {
  const { manager, codexComposerCalls } = await createManager(null, undefined, {
    butlerSkills: [{ id: "skill-review", name: "review", description: "Review changes", invocation: "/skill:review" }]
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  const suggestions = await manager.listComposerSuggestions(pair.id, "$", "rev");
  assert.deepEqual(suggestions?.map((suggestion) => ({ kind: suggestion.kind, label: suggestion.label })), [{ kind: "skill", label: "review" }]);
  assert.deepEqual(codexComposerCalls, []);
});

test("Butler slash suggestions include worker-only skills with environment availability", async () => {
  const { manager } = await createManager(null, undefined, {
    skillsByEnvironment: {
      "worker-pi": [{ id: "pi-asiri", name: "asiri", description: "Operate secrets safely", invocation: "/skill:asiri" }],
      "worker-codex": [{ id: "codex-asiri", name: "asiri", description: "Operate secrets safely", invocation: "$asiri" }]
    }
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  const suggestions = await manager.listComposerSuggestions(pair.id, "/", "skill:asi");
  const skillSuggestion = suggestions?.find((suggestion) => suggestion.label === "/skill:asiri");

  assert.equal(skillSuggestion?.kind, "command");
  assert.match(skillSuggestion?.detail ?? "", /Worker Pi, Worker Codex/);
});

test("worker-only skill invocation routes through Butler without native Butler expansion", async () => {
  const { manager, service } = await createManager(null, undefined, {
    skillsByEnvironment: {
      "worker-codex": [{ id: "codex-asiri", name: "asiri", description: "Operate secrets safely", invocation: "$asiri" }]
    }
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({ pairId: pair.id, text: "/skill:asiri rotate the staging token", imageReferenceIds: [], fileReferenceIds: [] });
  const prompt = service.messages.at(-1)?.text ?? "";

  assert.doesNotMatch(prompt, /^\/skill:asiri/);
  assert.match(prompt, /^MANOR-WIDE SKILL ROUTING/);
  assert.match(prompt, /Selected Worker availability: installed/);
  assert.match(prompt, /rotate the staging token$/);
});

test("Butler-only skill invocation requires provisioning before Worker delegation", async () => {
  const { manager, service } = await createManager(null, undefined, {
    butlerSkills: [{ id: "butler-asiri", name: "asiri", description: "Operate secrets safely", invocation: "/skill:asiri" }]
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({ pairId: pair.id, text: "/skill:asiri rotate the staging token", imageReferenceIds: [], fileReferenceIds: [] });
  const prompt = service.messages.at(-1)?.text ?? "";

  assert.match(prompt, /^\/skill:asiri\n\nMANOR-WIDE SKILL ROUTING/);
  assert.match(prompt, /Selected Worker availability: not installed/);
  assert.match(prompt, /propose installing the exact skill in worker-codex/);
});

test("shared Butler and Worker skills expand natively and delegate without provisioning", async () => {
  const shared = { name: "asiri", description: "Operate secrets safely" };
  const { manager, service } = await createManager(null, undefined, {
    skillsByEnvironment: {
      "butler-pi": [{ ...shared, id: "butler-asiri", invocation: "/skill:asiri" }],
      "worker-codex": [{ ...shared, id: "codex-asiri", invocation: "$asiri" }]
    }
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({ pairId: pair.id, text: "/skill:asiri rotate the staging token", imageReferenceIds: [], fileReferenceIds: [] });
  const prompt = service.messages.at(-1)?.text ?? "";

  assert.match(prompt, /^\/skill:asiri\n\nMANOR-WIDE SKILL ROUTING/);
  assert.match(prompt, /Selected Worker availability: installed/);
  assert.doesNotMatch(prompt, /propose installing the exact skill/);
});

test("unknown skill invocation asks Butler to acquire it before delegation", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  await manager.sendOperatorMessage({ pairId: pair.id, text: "/skill:unknown do the work", imageReferenceIds: [], fileReferenceIds: [] });
  const prompt = service.messages.at(-1)?.text ?? "";

  assert.doesNotMatch(prompt, /^\/skill:unknown/);
  assert.match(prompt, /No Manor environment currently has this skill/);
  assert.match(prompt, /do the work$/);
});

test("unmatched Butler skill searches offer an agent handoff", async () => {
  const { manager, codexComposerCalls } = await createManager(null, undefined, {
    butlerSkills: [{ id: "skill-review", name: "review", description: "Review changes", invocation: "/skill:review" }]
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });
  const suggestions = await manager.listComposerSuggestions(pair.id, "$", "release-notes");
  assert.deepEqual(suggestions, [{
    id: "action:find-or-create-skill:release-notes",
    kind: "action",
    label: "Find or create a skill for release-notes",
    detail: "Ask Butler to find an existing skill or create one with you.",
    insertText: "Find or create a skill for release-notes."
  }]);
  assert.deepEqual(codexComposerCalls, []);
});

test("sendOperatorMessage uses fallback title when generator cannot use a model", async () => {
  const calls: string[] = [];
  const { manager, pairStore } = await createManager({
    async generateTitle(input) {
      calls.push(input.firstUserPrompt);
      return "First prompt";
    }
  });
  const pair = await manager.createPair();

  await manager.sendOperatorMessage({ pairId: pair.id, text: "First prompt", imageReferenceIds: [], fileReferenceIds: [] });
  await Promise.resolve();
  await manager.sendOperatorMessage({ pairId: pair.id, text: "Second prompt", imageReferenceIds: [], fileReferenceIds: [] });
  await Promise.resolve();

  assert.deepEqual(calls, ["First prompt"]);
  assert.equal(pairStore.getPair(pair.id)?.title, "First prompt");
});

test("sendOperatorMessage preserves manual titles", async () => {
  const calls: string[] = [];
  const { manager, pairStore } = await createManager({
    async generateTitle(input) {
      calls.push(input.firstUserPrompt);
      return "Generated title";
    }
  });
  const pair = await manager.createPair({ title: "Manual title" });

  await manager.sendOperatorMessage({ pairId: pair.id, text: "First prompt", imageReferenceIds: [], fileReferenceIds: [] });
  await Promise.resolve();

  assert.deepEqual(calls, []);
  assert.equal(pairStore.getPair(pair.id)?.title, "Manual title");
});

test("getPairDetail catches up default titles for existing first user messages", async () => {
  const calls: string[] = [];
  const { manager, pairStore, service } = await createManager({
    async generateTitle(input) {
      calls.push(input.firstUserPrompt);
      return "Self Improvement Check";
    }
  });
  const pair = await manager.createPair();
  service.messages.push({
    id: "message-existing",
    role: "user",
    text: "Is self improvement on for this manor instance?",
    at: Date.now(),
    taskDurationMs: null,
    kind: "message"
  });

  await manager.getPairDetail(pair.id, null, 120);
  await Promise.resolve();

  assert.deepEqual(calls, ["Is self improvement on for this manor instance?"]);
  assert.equal(pairStore.getPair(pair.id)?.title, "Self Improvement Check");
});

test("sendOperatorMessage skips attachment-only prompts", async () => {
  const calls: string[] = [];
  const { manager } = await createManager({
    async generateTitle(input) {
      calls.push(input.firstUserPrompt);
      return "Generated title";
    }
  });
  const pair = await manager.createPair();

  await manager.sendOperatorMessage({ pairId: pair.id, text: "", imageReferenceIds: ["image-1"], fileReferenceIds: [] });
  await Promise.resolve();

  assert.deepEqual(calls, []);
});

test("refreshModelSettings refreshes loaded pair services", async () => {
  const { manager, service } = await createManager();
  await manager.createPair();

  await manager.refreshModelSettings();

  assert.equal(service.refreshCount, 1);
});

test("createWorkerPair registers external work for Butler review", async () => {
  const { manager, service, store } = await createManager();
  store.upsertThreadSummary({ id: "external-worker", source: "appServer", status: "active", turns: [] });

  const detail = await manager.createWorkerPair({
    threadId: "external-worker",
    task: "Improve Manor",
    runtime: "pi-rpc",
    provider: "opencode-go",
    model: "opencode-go/minimax-m3",
    effort: "high"
  });

  assert.deepEqual(service.trackedExternalThreads, ["external-worker"]);
  assert.deepEqual({
    runtime: detail.worker?.runtime,
    provider: detail.worker?.provider,
    model: detail.worker?.model,
    effort: detail.worker?.requestedReasoningEffort
  }, {
    runtime: "pi-rpc",
    provider: "opencode-go",
    model: "opencode-go/minimax-m3",
    effort: "high"
  });
});

test("deletePair waits for durable pair-store deletion", async () => {
  const { manager, pairStore } = await createManager();
  const pair = pairStore.createPair({ title: "Delete durably" });
  await pairStore.flushPendingSave();
  const order: string[] = [];
  const deletePair = pairStore.deletePair.bind(pairStore);
  const flushPendingSave = pairStore.flushPendingSave.bind(pairStore);
  pairStore.deletePair = ((pairId: string) => {
    order.push("delete");
    return deletePair(pairId);
  }) as typeof pairStore.deletePair;
  pairStore.flushPendingSave = (async () => {
    await flushPendingSave();
    order.push("flush");
  }) as typeof pairStore.flushPendingSave;

  assert.equal(await manager.deletePair(pair.id), true);
  assert.deepEqual(order, ["delete", "flush"]);
});

test("deletePair stops active Butler work before removing supervision", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair({ title: "Stop before delete" });

  assert.equal(await manager.deletePair(pair.id), true);
  assert.equal(service.cancelReviewCount, 1);
  assert.equal(service.stopCount, 1);
  assert.equal(service.disposeCount, 1);
  assert.deepEqual(service.lifecycleEvents, ["stop-prompt", "cancel-review", "dispose"]);
});

test("quiesced pairs cannot restart supervision until explicitly resumed", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair({ title: "Pause before worker stop" });

  assert.equal(await manager.quiescePair(pair.id), true);
  assert.equal(service.cancelReviewCount, 1);
  assert.equal(service.stopCount, 1);
  assert.equal(service.disposeCount, 1);
  await assert.rejects(() => manager.getPairDetail(pair.id, null, 120), /session is closing/);

  assert.equal(await manager.resumePair(pair.id), true);
  assert.equal(service.startCount, 2);
});

test("deletePair restores the live pair when durable deletion fails", async () => {
  const { manager, pairStore, service } = await createManager();
  const pair = await manager.createPair({ title: "Retain on failure" });
  pairStore.flushPendingSave = (async () => {
    throw new Error("pair state write failed");
  }) as typeof pairStore.flushPendingSave;

  await assert.rejects(() => manager.deletePair(pair.id), /pair state write failed/);
  assert.equal(pairStore.getPair(pair.id)?.id, pair.id);
  assert.equal(service.stopCount, 1);
  assert.equal(service.disposeCount, 1);
  assert.equal(service.startCount, 2);
});

test("failed deletion queues a durable restore behind an already queued delete save", async () => {
  const { manager, pairStore, service } = await createManager();
  const pair = await manager.createPair({ title: "Restore after queued delete" });
  const snapshots: string[][] = [];
  let markFirstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve; });
  const firstSaveRelease = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
  const internals = pairStore as unknown as { flushSave: () => Promise<void>; saveQueued: boolean };
  internals.flushSave = async () => {
    internals.saveQueued = false;
    snapshots.push(pairStore.listSummaries().map((entry) => entry.id));
    if (snapshots.length === 1) {
      markFirstSaveStarted();
      await firstSaveRelease;
      throw new Error("first pair save failed");
    }
  };

  pairStore.updatePairTitle(pair.id, "Start an in-flight save");
  await firstSaveStarted;
  const deleting = manager.deletePair(pair.id);
  while (pairStore.getPair(pair.id)) await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirstSave();

  await assert.rejects(deleting, /first pair save failed/);
  await pairStore.flushPendingSave();
  assert.deepEqual(snapshots.slice(0, 2), [[pair.id], []]);
  assert.deepEqual(snapshots.at(-1), [pair.id]);
  assert.equal(pairStore.getPair(pair.id)?.id, pair.id);
  assert.equal(service.startCount, 2);
});

test("startup resumes Butler services for persisted active Worker sessions", async () => {
  const { manager, pairStore, service, store } = await createManager();
  store.upsertThreadSummary({ id: "persisted-worker", source: "appServer", status: "active", turns: [] });
  const pair = pairStore.createPair({ title: "Persisted work" });
  pairStore.attachWorker(pair.id, { threadId: "persisted-worker", task: "Resume review" });

  await manager.startSupervisedSessions();

  assert.equal(service.startCount, 1);
  assert.deepEqual(service.trackedExternalThreads, ["persisted-worker"]);
});

test("startup resumes idle attached Workers that never produced a report", async () => {
  const { manager, pairStore, service, store } = await createManager();
  store.upsertThreadSummary({ id: "missing-report-worker", source: "appServer", status: "idle", turns: [] });
  const pair = pairStore.createPair({ title: "Missing callback" });
  pairStore.attachWorker(pair.id, { threadId: "missing-report-worker", task: "Recover callback" });

  await manager.startSupervisedSessions();

  assert.equal(service.startCount, 1);
  assert.deepEqual(service.trackedExternalThreads, ["missing-report-worker"]);
});

test("startup does not rearm an already reviewed historical Worker", async () => {
  const { manager, pairStore, service, store } = await createManager();
  store.upsertThreadSummary({ id: "reviewed-worker", source: "appServer", status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed", items: [] }] });
  const report = store.recordWorkerReport("reviewed-worker", { turnId: "turn-1", status: "completed", summary: "Done", details: null });
  const pair = pairStore.createPair({ title: "Reviewed work" });
  pairStore.attachWorker(pair.id, { threadId: "reviewed-worker", task: "Already reviewed" });
  pairStore.updatePairSnapshot(pair.id, {
    lastMessage: { id: "callback-reviewed-worker:turn-1", role: "butler", lane: "butler", text: "Done", at: report.updatedAt, sourceThreadId: "reviewed-worker", memoryObservationId: null, metadata: {} }
  });
  assert.equal(pairStore.getPair(pair.id)?.worker?.lastReviewedReportAt, report.updatedAt);

  await manager.startSupervisedSessions();

  assert.equal(service.startCount, 0);
  assert.deepEqual(service.trackedExternalThreads, []);
});

test("retryBlockedReview delegates recovery to the pair Butler", async () => {
  const { manager, pairStore, service, store } = await createManager();
  store.upsertThreadSummary({ id: "paused-worker", source: "appServer", status: "idle", turns: [] });
  const pair = await manager.createPair();
  pairStore.attachWorker(pair.id, { threadId: "paused-worker" });

  await manager.retryBlockedReview(pair.id);

  assert.equal(service.retryReviewCount, 1);
});

test("stopReview cancels the isolated review through the pair Butler", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair();

  const detail = await manager.stopReview(pair.id);

  assert.equal(detail?.id, pair.id);
  assert.equal(service.cancelReviewCount, 1);
});

test("loaded pair services read current worker compose defaults", async () => {
  let serviceOptions: { getWorkerDefaults?: () => { runtime: string | null; harness?: string | null; model?: string | null; effort?: string | null; cwd?: string | null } | null } | null = null;
  const model: ModelOption = {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    provider: null,
    supportsReasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium"
  };
  const { manager } = await createManager(null, (options) => {
    serviceOptions = options as typeof serviceOptions;
  }, { workerModels: [model] });
  const pair = await manager.createPair();

  await manager.setWorkerModel(pair.id, "gpt-5-codex");
  await manager.setWorkerEffort(pair.id, "xhigh");

  assert.deepEqual(serviceOptions?.getWorkerDefaults?.(), {
    runtime: "auto",
    harness: "codex",
    model: "gpt-5-codex",
    effort: "xhigh",
    threadId: null,
    cwd: "/repos"
  });
});

test("new pair services read the inherited Butler compose defaults", async () => {
  let serviceOptions: { getButlerDefaults?: () => { model: string | null; thinkingLevel: string | null } | null } | null = null;
  const { manager, pairStore } = await createManager(null, (options) => {
    serviceOptions = options as typeof serviceOptions;
  });
  const firstPair = await manager.createPair();
  pairStore.updatePairComposeOverrides(firstPair.id, {
    butlerModel: "opencode-go/qwen3.7-max",
    butlerThinkingLevel: "high"
  });

  await manager.createPair();

  assert.deepEqual(serviceOptions?.getButlerDefaults?.(), {
    model: "opencode-go/qwen3.7-max",
    thinkingLevel: "high"
  });
});

test("Butler model changes persist the effective model and thinking level", async () => {
  const targetModel: ModelOption = {
    id: "opencode-go/qwen3.7-max",
    label: "Qwen 3.7 Max",
    provider: "opencode-go",
    supportsReasoning: true,
    supportedThinkingLevels: ["off"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
  const { manager, pairStore, service } = await createManager();
  service.compose = {
    provider: "openai-codex",
    model: "openai-codex/gpt-5-codex",
    thinkingLevel: "xhigh",
    availableThinkingLevels: ["low", "medium", "high", "xhigh"],
    availableModels: [targetModel]
  };
  service.nextCompose = {
    provider: "opencode-go",
    model: targetModel.id,
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    availableModels: [targetModel]
  };
  const pair = await manager.createPair();

  await manager.setButlerModel(pair.id, targetModel.id);

  assert.equal(pairStore.getPair(pair.id)?.butlerModel, targetModel.id);
  assert.equal(pairStore.getPair(pair.id)?.butlerThinkingLevel, "off");
  assert.equal(pairStore.getLastUsedCompose()?.butlerModel, targetModel.id);
  assert.equal(pairStore.getLastUsedCompose()?.butlerThinkingLevel, "off");
});

test("Butler model and thinking changes wait for the active main-chat turn", async () => {
  const { manager, service } = await createManager();
  service.compose.availableModels = [{
    id: "openai/gpt-5",
    label: "GPT-5",
    provider: "openai",
    supportsReasoning: true,
    supportedThinkingLevels: ["medium", "high"],
    supportedReasoningEfforts: ["medium", "high"],
    defaultReasoningEffort: "medium"
  }];
  const pair = await manager.createPair();
  service.pending = true;

  await assert.rejects(() => manager.setButlerModel(pair.id, "openai/gpt-5"), /Wait for this turn to finish/);
  await assert.rejects(() => manager.setButlerThinkingLevel(pair.id, "high"), /Wait for this turn to finish/);
});

test("an unavailable chosen Butler model blocks chat with inventory remediation", async () => {
  const { manager, pairStore, service } = await createManager();
  const pair = await manager.createPair();
  pairStore.updatePairComposeOverrides(pair.id, { butlerModel: "ollama-cloud/missing-model" });

  const detail = await manager.getPairDetail(pair.id, null, 120);

  assert.match(detail?.butlerLastError ?? "", /chosen Butler model .* current model inventory/i);
  await assert.rejects(() => manager.sendOperatorMessage({ pairId: pair.id, text: "Hello", imageReferenceIds: [], fileReferenceIds: [] }), /Retry the provider check/);
  assert.equal(service.messages.length, 0);
});

test("an empty Butler provider inventory blocks chat with a settings action message", async () => {
  const { manager, service } = await createManager();
  const pair = await manager.createPair();
  service.compose = { ...service.compose, provider: null, model: null, availableModels: [] };

  const detail = await manager.getPairDetail(pair.id, null, 120);

  assert.match(detail?.butlerLastError ?? "", /No connected Butler model/);
  await assert.rejects(() => manager.sendOperatorMessage({ pairId: pair.id, text: "Hello", imageReferenceIds: [], fileReferenceIds: [] }), /Open Settings/);
});

test("attached worker model selection changes only the next-worker default", async () => {
  const noEffortModel: ModelOption = {
    id: "gpt-chat",
    label: "GPT Chat",
    provider: null,
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
  const { manager, pairStore, store, codexUpdates, threadEffortUpdates } = await createManager(null, undefined, { workerModels: [noEffortModel] });
  const pair = await manager.createPair();
  store.upsertThreadSummary({ id: "worker-thread", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, { threadId: "worker-thread" });

  await manager.setWorkerModel(pair.id, "gpt-chat");

  assert.deepEqual(threadEffortUpdates, []);
  assert.deepEqual(codexUpdates, []);
  assert.equal(pairStore.getPair(pair.id)?.workerEffort, null);
});

test("handoffWorker resolves the target model without mutating the active worker", async () => {
  const current: ModelOption = {
    id: "gpt-5.4", label: "GPT-5.4", provider: null, supportsReasoning: true,
    supportedThinkingLevels: ["medium", "high"], supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium"
  };
  const target: ModelOption = {
    id: "gpt-5.5", label: "GPT-5.5", provider: null, supportsReasoning: true,
    supportedThinkingLevels: ["high", "xhigh"], supportedReasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high"
  };
  const { manager, pairStore, service, store } = await createManager(null, undefined, { workerModels: [current, target] });
  const pair = await manager.createPair();
  store.upsertThreadSummary({ id: "worker-current", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, { threadId: "worker-current", runtime: "openai", provider: "openai-codex", model: current.id, effort: "medium" });

  await manager.handoffWorker(pair.id, target.id, "codex", "xhigh");

  assert.deepEqual(service.handoffs, [{ sourceThreadId: "worker-current", harness: "codex", model: target.id, effort: "xhigh", butlerThreadId: "fake-session" }]);
  assert.equal(pairStore.getPair(pair.id)?.worker?.model, current.id);
});

test("handoffWorker serializes competing replacements for one pair", async () => {
  const current: ModelOption = {
    id: "gpt-current", label: "Current", provider: null, supportsReasoning: true,
    supportedThinkingLevels: ["high"], supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high"
  };
  const firstTarget = { ...current, id: "gpt-first", label: "First" };
  const secondTarget = { ...current, id: "gpt-second", label: "Second" };
  const { manager, pairStore, service, store } = await createManager(null, undefined, { workerModels: [current, firstTarget, secondTarget] });
  const pair = await manager.createPair();
  store.upsertThreadSummary({ id: "worker-current", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, { threadId: "worker-current", runtime: "openai", provider: "openai-codex", model: current.id, effort: "high" });
  service.handoffDelayMs = 20;

  await Promise.all([
    manager.handoffWorker(pair.id, firstTarget.id, "codex", "high"),
    manager.handoffWorker(pair.id, secondTarget.id, "codex", "high")
  ]);

  assert.equal(service.maxConcurrentHandoffs, 1);
  assert.deepEqual(service.handoffs.map((handoff) => handoff.model), [firstTarget.id, secondTarget.id]);
});

test("setWorkspaceCwd updates an unattached session after validation", async () => {
  const validated: string[] = [];
  const { manager, pairStore } = await createManager(null, undefined, {
    validateWorkspace: async (cwd) => {
      validated.push(cwd);
      return cwd === "/repos" ? cwd : "/repos/canonical-project";
    }
  });
  const pair = await manager.createPair({ defaultCwd: "/repos" });

  const updated = await manager.setWorkspaceCwd(pair.id, "/repos/project-link");

  assert.deepEqual(validated, ["/repos", "/repos/project-link"]);
  assert.equal(updated?.defaultCwd, "/repos/canonical-project");
  assert.equal(pairStore.getPair(pair.id)?.defaultCwd, "/repos/canonical-project");
});

test("createPair validates and canonicalizes an initial workspace", async () => {
  const requested: string[] = [];
  const { manager } = await createManager(null, undefined, {
    validateWorkspace: async (cwd) => {
      requested.push(cwd);
      return "/repos/canonical-project";
    }
  });

  const pair = await manager.createPair({ defaultCwd: "/repos/project-link" });

  assert.deepEqual(requested, ["/repos/project-link"]);
  assert.equal(pair.defaultCwd, "/repos/canonical-project");
});

test("setWorkspaceCwd replaces an idle attached Worker in the new workspace", async () => {
  const { manager, pairStore, service, store } = await createManager();
  const pair = await manager.createPair({ defaultCwd: "/repos/old" });
  store.upsertThreadSummary({ id: "worker-current", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, {
    threadId: "worker-current",
    cwd: "/repos/old",
    runtime: "openai",
    harness: "codex",
    provider: "openai-codex",
    model: "gpt-5-codex",
    effort: "high"
  });

  await manager.setWorkspaceCwd(pair.id, "/repos/new");

  assert.deepEqual(service.handoffs, [{
    sourceThreadId: "worker-current",
    harness: "codex",
    model: "gpt-5-codex",
    effort: "high",
    butlerThreadId: "fake-session",
    cwd: "/repos/new"
  }]);
  assert.equal(pairStore.getPair(pair.id)?.defaultCwd, "/repos/new");
});

test("setWorkspaceCwd rejects running Workers and rolls back failed replacements", async () => {
  const { manager, pairStore, service, store } = await createManager();
  const pair = await manager.createPair({ defaultCwd: "/repos/old" });
  store.upsertThreadSummary({ id: "worker-current", source: "appServer", status: "active", turns: [{ id: "turn-active", status: "inProgress", items: [] }] });
  pairStore.attachWorker(pair.id, {
    threadId: "worker-current",
    cwd: "/repos/old",
    runtime: "openai",
    harness: "codex",
    model: "gpt-5-codex"
  });

  await assert.rejects(() => manager.setWorkspaceCwd(pair.id, "/repos/new"), /current Worker turn/);
  assert.equal(pairStore.getPair(pair.id)?.defaultCwd, "/repos/old");

  store.upsertThreadSummary({ id: "worker-current", source: "appServer", status: "idle", turns: [] });
  service.handoffWorker = async () => { throw new Error("replacement failed"); };
  await assert.rejects(() => manager.setWorkspaceCwd(pair.id, "/repos/new"), /replacement failed/);
  assert.equal(pairStore.getPair(pair.id)?.defaultCwd, "/repos/old");

  const unloadedPair = pairStore.createPair({ defaultCwd: "/repos/old" });
  store.upsertThreadSummary({ id: "worker-unloaded", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(unloadedPair.id, {
    threadId: "worker-unloaded",
    cwd: "/repos/old",
    runtime: "openai",
    harness: "codex",
    model: "gpt-5-codex"
  });
  service.start = async () => { throw new Error("Butler startup failed"); };
  await assert.rejects(() => manager.setWorkspaceCwd(unloadedPair.id, "/repos/new"), /Butler startup failed/);
  assert.equal(pairStore.getPair(unloadedPair.id)?.defaultCwd, "/repos/old");
});

test("pair attachment acknowledgement uses compare-and-swap and exposes an exact rollback", async () => {
  let serviceOptions: {
    operatorSink?: {
      onDelegationAcknowledgement?: (input: Record<string, unknown>) => { attached: boolean; rollback?: () => boolean } | void;
    };
  } | null = null;
  const { manager, pairStore, store } = await createManager(null, (options) => {
    serviceOptions = options as typeof serviceOptions;
  });
  const pair = await manager.createPair();
  store.upsertThreadSummary({ id: "worker-old", source: "appServer", status: "idle", turns: [] });
  store.upsertThreadSummary({ id: "worker-new", source: "pi-rpc", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, { threadId: "worker-old", runtime: "openai", provider: "openai-codex", model: "gpt-old", effort: "high", task: "Original" });
  const original = structuredClone(pairStore.getPair(pair.id)?.worker ?? null);

  const accepted = serviceOptions?.operatorSink?.onDelegationAcknowledgement?.({
    threadId: "worker-new", text: "Switched", at: Date.now(), runtime: "pi-rpc", provider: "opencode-go",
    model: "opencode-go/minimax-m3", effort: "medium", replacesThreadId: "worker-old"
  });
  assert.equal(accepted?.attached, true);
  assert.equal(pairStore.getPair(pair.id)?.worker?.threadId, "worker-new");
  assert.equal(pairStore.getPair(pair.id)?.workerModel, null);
  assert.equal(pairStore.getPair(pair.id)?.workerEffort, null);
  assert.equal(accepted?.rollback?.(), true);
  assert.deepEqual(pairStore.getPair(pair.id)?.worker, original);

  const stale = serviceOptions?.operatorSink?.onDelegationAcknowledgement?.({
    threadId: "worker-new", text: "Stale", at: Date.now(), runtime: "pi-rpc", provider: "opencode-go",
    model: "opencode-go/minimax-m3", effort: "medium", replacesThreadId: "worker-someone-else"
  });
  assert.equal(stale?.attached, false);
  assert.deepEqual(pairStore.getPair(pair.id)?.worker, original);

  const automaticReplacement = serviceOptions?.operatorSink?.onDelegationAcknowledgement?.({
    threadId: "worker-new", text: "Recovered with a replacement", at: Date.now(), runtime: "pi-rpc",
    provider: "opencode-go", model: "opencode-go/minimax-m3", effort: "medium"
  });
  assert.equal(automaticReplacement?.attached, false);
  assert.deepEqual(pairStore.getPair(pair.id)?.worker, original);

  store.removeThread("worker-old");
  pairStore.syncWorkerReports();
  const replacement = serviceOptions?.operatorSink?.onDelegationAcknowledgement?.({
    threadId: "worker-new", text: "Fresh delegation", at: Date.now(), runtime: "pi-rpc", provider: "opencode-go",
    model: "opencode-go/minimax-m3", effort: "medium"
  });
  assert.equal(replacement?.attached, true);
  assert.equal(pairStore.getPair(pair.id)?.worker?.threadId, "worker-new");
});
