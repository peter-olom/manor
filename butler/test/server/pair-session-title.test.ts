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
  startCount = 0;
  pending = false;
  trackedExternalThreads: string[] = [];
  handoffs: Array<{ sourceThreadId: string; harness: string; model: string; effort: string | null; butlerThreadId?: string | null }> = [];
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

  async handoffWorker(input: { sourceThreadId: string; harness: string; model: string; effort: string | null; butlerThreadId?: string | null }): Promise<void> {
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

async function createManager(generator: SessionTitleGenerator | null = null, onCreateService?: (options: unknown) => void, runtime?: { workerModels?: ModelOption[] }): Promise<{
  manager: PairSessionManager;
  pairStore: PairStore;
  service: FakeButlerService;
  store: ButlerStateStore;
  codexUpdates: Array<{ model: string; effort: ReasoningEffort | null }>;
  threadEffortUpdates: Array<{ threadId: string; effort: ReasoningEffort }>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-pair-session-test-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const pairStore = new PairStore(path.join(dir, "pairs.json"), store);
  await pairStore.load();
  const service = new FakeButlerService();
  const codexUpdates: Array<{ model: string; effort: ReasoningEffort | null }> = [];
  const threadEffortUpdates: Array<{ threadId: string; effort: ReasoningEffort }> = [];
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
      }
    },
    hostController: {},
    runtimeBroker: {},
    serviceTemplateRegistry: {},
    imageStore: { resolveViews: () => [] },
    fileStore: { resolveViews: () => [], getFilePath: () => null },
    piAuthPath: path.join(dir, "pi-auth.json"),
    codexAuthPath: path.join(dir, "codex-auth.json"),
    codexConfigDir: dir,
    getCodexAuthStatus: () => ({ loggedIn: true }),
    sessionRootDir: path.join(dir, "sessions"),
    artifactsDir: path.join(dir, "artifacts"),
    sessionTitleGenerator: generator,
    createButlerService: (serviceOptions: unknown) => {
      onCreateService?.(serviceOptions);
      return service as never;
    }
  } as never);
  return { manager, pairStore, service, store, codexUpdates, threadEffortUpdates };
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
  let serviceOptions: { getWorkerDefaults?: () => { runtime: string | null; harness?: string | null; model?: string | null; effort?: string | null } | null } | null = null;
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
    threadId: null
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
