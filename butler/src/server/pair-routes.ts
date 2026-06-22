import type express from "express";

import { buildCodexInputWithReferences, buildReferencePromptText } from "./reference-inputs.js";
import { formatButlerMemoryRetrieval, retrieveButlerMemory } from "./memory-retrieval.js";
import { buildPairButlerReflection, buildPairWorkerDeveloperInstructions, buildPairWorkerPrompt } from "./pair-prompts.js";
import { readFileReferenceIds, readImageReferenceIds } from "./server-runtime-helpers.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { PairStore } from "./pair-store.js";
import type { ButlerStateStore } from "./state-store.js";
import type { PairMemoryCard, PairMemoryResponse } from "../shared/pairing.js";

type PairRouteAccess = {
  app: express.Express;
  codexClient: CodexAppServerClient;
  fileStore: FileReferenceStore;
  imageStore: ImageReferenceStore;
  pairStore: PairStore;
  store: ButlerStateStore;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" && value.length > 0 ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pairProject(pairId: string) {
  return { projectId: `pair:${pairId}`, projectLabel: "Manor pairs" };
}

function buildMemoryCards(pairStore: PairStore, store: ButlerStateStore, pairId: string, query: string | null): PairMemoryResponse {
  const pair = pairStore.getPair(pairId);
  if (!pair) {
    return { cards: [] };
  }
  const retrieval = retrieveButlerMemory(store, {
    projectId: pair.projectId,
    threadId: pair.worker?.threadId ?? null,
    query: query ?? pair.memoryQuery,
    includeGlobal: true,
    includeProvenance: true,
    limit: 5
  });
  const cards: PairMemoryCard[] = [
    ...retrieval.projectRollups.map((memory) => ({
      id: `project:${memory.projectId}`,
      kind: "project" as const,
      title: memory.projectLabel,
      body: memory.summary ?? "No project summary yet.",
      meta: `${memory.entries.length} entries`
    })),
    ...retrieval.jobMemories.map((memory) => ({
      id: `job:${memory.threadId}`,
      kind: "job" as const,
      title: memory.projectLabel,
      body: memory.latestCheckpoint ?? memory.nextAction ?? memory.requestedTask ?? "No job memory summary.",
      meta: memory.threadId
    })),
    ...retrieval.butlerMemories.map((memory) => ({
      id: `butler:${memory.id}`,
      kind: "butler" as const,
      title: memory.summary,
      body: (memory.details ?? memory.tags.join(" ")) || "Global Butler memory",
      meta: memory.tags.join(" · ") || null
    })),
    ...retrieval.warnings.map((warning, index) => ({
      id: `warning:${index}`,
      kind: "warning" as const,
      title: "Memory note",
      body: warning,
      meta: null
    }))
  ];
  return { cards };
}

function recordPairObservation(access: PairRouteAccess, input: { pairId: string; text: string; role: string; threadId?: string | null }) {
  const { projectId, projectLabel } = pairProject(input.pairId);
  return access.store.recordMemoryObservation({
    idempotencyKey: `pair:${input.pairId}:${input.role}:${Date.now()}:${input.text.slice(0, 80)}`,
    projectId,
    projectLabel,
    threadId: input.threadId ?? null,
    sourceKind: input.role === "user" ? "operator_message" : "system",
    sourceId: input.pairId,
    summary: input.text.slice(0, 240),
    details: input.text,
    payload: { pairId: input.pairId, role: input.role },
    durable: true
  });
}

export function registerPairRoutes(access: PairRouteAccess): void {
  const { app, codexClient, fileStore, imageStore, pairStore, store } = access;

  app.get("/api/pairs", (_request, response) => {
    response.json({ pairs: pairStore.listSummaries() });
  });

  app.post("/api/pairs", (request, response) => {
    const title = readString(request.body?.title);
    const defaultCwd = readString(request.body?.defaultCwd);
    const pair = pairStore.createPair({ title: title || null, defaultCwd: defaultCwd || null });
    response.status(201).json({ pair: pairStore.getPairDetail(pair.id, null, 80) });
  });

  app.get("/api/pairs/:pairId", (request, response) => {
    const before = readLimit(request.query.before, NaN);
    const limit = readLimit(request.query.limit, 120);
    const pair = pairStore.getPairDetail(request.params.pairId, Number.isFinite(before) ? before : null, limit);
    if (!pair) {
      response.status(404).json({ error: "Butler chat not found" });
      return;
    }
    response.json({ pair });
  });

  app.delete("/api/pairs/:pairId", (request, response) => {
    response.json({ ok: pairStore.deletePair(request.params.pairId) });
  });

  app.get("/api/pairs/:pairId/memory", (request, response) => {
    const query = readString(request.query.query);
    response.json(buildMemoryCards(pairStore, store, request.params.pairId, query || null));
  });

  app.get("/api/pairs/:pairId/worker-thread", async (request, response) => {
    const pair = pairStore.getPair(request.params.pairId);
    if (!pair?.worker) {
      response.json({ thread: null });
      return;
    }
    try {
      await codexClient.loadThread(pair.worker.threadId);
    } catch {
      // The local store may still have the thread summary/detail from prior events.
    }
    response.json({ thread: store.getThreadDetail(pair.worker.threadId) ?? null });
  });

  app.post("/api/pairs/:pairId/messages", async (request, response) => {
    const pair = pairStore.getPair(request.params.pairId);
    if (!pair) {
      response.status(404).json({ error: "Butler chat not found" });
      return;
    }

    const text = readString(request.body?.text);
    const target = request.body?.target === "worker" ? "worker" : "butler";
    const imageReferenceIds = readImageReferenceIds(request.body);
    const fileReferenceIds = readFileReferenceIds(request.body);
    if (!text && imageReferenceIds.length === 0 && fileReferenceIds.length === 0) {
      response.status(400).json({ error: "text or attachments are required" });
      return;
    }

    try {
      const referenceText = buildReferencePromptText({ text, imageStore, imageReferenceIds, fileStore, fileReferenceIds, includeIds: true, includeFilePaths: true });
      const displayText = text || referenceText || "Attached references.";
      const observation = recordPairObservation(access, { pairId: pair.id, text: displayText, role: "user", threadId: target === "worker" ? pair.worker?.threadId ?? null : null });
      pairStore.appendMessage(pair.id, { role: "user", lane: target === "worker" ? "worker" : "butler", text: displayText, memoryObservationId: observation.id, sourceThreadId: target === "worker" ? pair.worker?.threadId ?? null : null });

      const memoryText = formatButlerMemoryRetrieval(retrieveButlerMemory(store, { query: displayText, threadId: pair.worker?.threadId ?? null, includeGlobal: true, includeProvenance: true, limit: 5 }));
      if (target === "worker") {
        if (!pair.worker) {
          response.status(409).json({ error: "Spin up this pair's worker before sending worker messages." });
          return;
        }
        const prompt = buildPairWorkerPrompt({ pair: pairStore.getPair(pair.id)!, task: referenceText || displayText, memoryText });
        await codexClient.sendMessage(pair.worker.threadId, buildCodexInputWithReferences({ text: prompt, imageStore, imageReferenceIds, fileStore, fileReferenceIds }));
        pairStore.noteWorkerHandoff(pair.id, prompt);
      } else {
        const reflection = buildPairButlerReflection({ task: displayText, memoryText, hasWorker: Boolean(pair.worker) });
        const butlerObservation = recordPairObservation(access, { pairId: pair.id, text: reflection, role: "butler", threadId: pair.worker?.threadId ?? null });
        pairStore.appendMessage(pair.id, { role: "butler", lane: "butler", text: reflection, memoryObservationId: butlerObservation.id });
        store.recordButlerMemory({ summary: displayText.slice(0, 180), details: displayText, source: "manual_chat_save", tags: ["pair", pair.id] });
      }

      response.status(202).json({ pair: pairStore.getPairDetail(pair.id, null, 120) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/worker", async (request, response) => {
    const pair = pairStore.getPair(request.params.pairId);
    if (!pair) {
      response.status(404).json({ error: "Butler chat not found" });
      return;
    }
    if (pair.worker) {
      response.status(409).json({ error: "This Butler chat already has one worker." });
      return;
    }

    const task = readString(request.body?.task) || pair.messages.filter((message) => message.role === "user").at(-1)?.text || pair.title;
    const cwd = readString(request.body?.cwd) || pair.defaultCwd;
    const effort = request.body?.effort === "minimal" || request.body?.effort === "low" || request.body?.effort === "medium" || request.body?.effort === "high" || request.body?.effort === "xhigh" ? request.body.effort : "xhigh";
    const memoryText = formatButlerMemoryRetrieval(retrieveButlerMemory(store, { query: task, includeGlobal: true, includeProvenance: true, limit: 6 }));
    const prompt = buildPairWorkerPrompt({ pair, task, memoryText });

    try {
      const result = await codexClient.startThread({
        task,
        input: [{ type: "text", text: prompt }],
        cwd,
        developerInstructions: buildPairWorkerDeveloperInstructions(pair),
        effort,
        openWindow: false
      });
      const updated = pairStore.attachWorker(pair.id, { threadId: result.threadId, task, cwd, handoffPrompt: prompt });
      recordPairObservation(access, { pairId: pair.id, text: `Worker ${result.threadId} started for: ${task}`, role: "system", threadId: result.threadId });
      response.status(202).json({ pair: pairStore.getPairDetail(updated.id, null, 120) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/worker/revert", (request, response) => {
    try {
      const pair = pairStore.revertWorker(request.params.pairId, readString(request.body?.text) || null);
      response.json({ pair: pairStore.getPairDetail(pair.id, null, 120) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
