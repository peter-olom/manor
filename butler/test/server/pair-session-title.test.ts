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

  async start(): Promise<void> {}

  dispose(): void {}

  async refreshModelSettings(): Promise<void> {
    this.refreshCount += 1;
    this.emit("change");
  }

  async stopPrompt(): Promise<void> {}

  setThinkingLevel(_level: never): void {}

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

  getShellSnapshot(): Record<string, unknown> {
    return {
      sessionId: "fake-session",
      ready: true,
      pending: false,
      isStreaming: false,
      lastError: null,
      compose: { thinkingLevel: "medium", availableThinkingLevels: ["low", "medium", "high", "xhigh"] },
      supervision: { callbacks: [] }
    };
  }
}

async function createManager(generator: SessionTitleGenerator | null = null, onCreateService?: (options: unknown) => void, runtime?: { codexModels?: ModelOption[] }): Promise<{
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
  const codexModels = runtime?.codexModels ?? [];
  const manager = new PairSessionManager({
    pairStore,
    store,
    codexClient: {
      getConnectionState: () => ({ connected: true, lastError: null, compose: { model: null, effort: null, availableModels: codexModels } }),
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

test("loaded pair services read current worker compose defaults", async () => {
  let serviceOptions: { getWorkerDefaults?: () => { runtime: string | null; model?: string | null; effort?: string | null } | null } | null = null;
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
  }, { codexModels: [model] });
  const pair = await manager.createPair();

  await manager.setWorkerRuntime(pair.id, "auto");
  await manager.setCodexModel(pair.id, "gpt-5-codex");
  await manager.setCodexEffort(pair.id, "xhigh");

  assert.deepEqual(serviceOptions?.getWorkerDefaults?.(), {
    runtime: "auto",
    model: "gpt-5-codex",
    effort: "xhigh"
  });
});

test("attached worker model switch skips thread effort update when target model has no effort", async () => {
  const noEffortModel: ModelOption = {
    id: "gpt-chat",
    label: "GPT Chat",
    provider: null,
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null
  };
  const { manager, pairStore, store, codexUpdates, threadEffortUpdates } = await createManager(null, undefined, { codexModels: [noEffortModel] });
  const pair = await manager.createPair();
  store.upsertThreadSummary({ id: "worker-thread", source: "appServer", status: "idle", turns: [] });
  pairStore.attachWorker(pair.id, { threadId: "worker-thread" });

  await manager.setCodexModel(pair.id, "gpt-chat");

  assert.deepEqual(threadEffortUpdates, []);
  assert.deepEqual(codexUpdates, [{ model: "gpt-chat", effort: null }]);
  assert.equal(pairStore.getPair(pair.id)?.codexEffort, null);
});
