import type express from "express";

import { readFileReferenceIds, readImageReferenceIds } from "./server-runtime-helpers.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import { isKnownReasoningEffort, isKnownThinkingLevel } from "../shared/pairing.js";

type PairRouteAccess = {
  app: express.Express;
  pairSessions: PairSessionManager;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" && value.length > 0 ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerPairRoutes(access: PairRouteAccess): void {
  const { app, pairSessions } = access;

  app.get("/api/pairs", async (_request, response) => {
    response.json({ pairs: await pairSessions.listSummaries() });
  });

  app.post("/api/pairs", async (request, response) => {
    try {
      const pair = await pairSessions.createPair({
        title: readString(request.body?.title) || null,
        defaultCwd: readString(request.body?.defaultCwd) || null
      });
      response.status(201).json({ pair });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/pairs/:pairId", async (request, response) => {
    try {
      const before = readLimit(request.query.before, NaN);
      const limit = readLimit(request.query.limit, 120);
      const pair = await pairSessions.getPairDetail(request.params.pairId, Number.isFinite(before) ? before : null, limit);
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ pair });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/pairs/:pairId", async (request, response) => {
    response.json({ ok: await pairSessions.deletePair(request.params.pairId) });
  });

  app.post("/api/pairs/:pairId/stop", async (request, response) => {
    try {
      const stopped = await pairSessions.stopButler(request.params.pairId);
      if (!stopped) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/pairs/:pairId", (request, response) => {
    const title = readString(request.body?.title);
    if (!title) {
      response.status(400).json({ error: "title is required" });
      return;
    }
    const pair = pairSessions.updatePairTitle(request.params.pairId, title);
    if (!pair) {
      response.status(404).json({ error: "Butler session not found" });
      return;
    }
    response.json({ pair });
  });

  app.get("/api/pairs/:pairId/worker-thread", async (request, response) => {
    try {
      response.json({ thread: await pairSessions.getWorkerThread(request.params.pairId) });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/messages", async (request, response) => {
    const text = readString(request.body?.text);
    const target = request.body?.target === "worker" ? "worker" : "butler";
    const imageReferenceIds = readImageReferenceIds(request.body);
    const fileReferenceIds = readFileReferenceIds(request.body);
    if (target === "worker") {
      response.status(409).json({ error: "Message Butler. Butler controls the Codex worker for this session." });
      return;
    }
    if (!text && imageReferenceIds.length === 0 && fileReferenceIds.length === 0) {
      response.status(400).json({ error: "text or attachments are required" });
      return;
    }

    try {
      const pair = await pairSessions.sendOperatorMessage({
        pairId: request.params.pairId,
        text,
        imageReferenceIds,
        fileReferenceIds
      });
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.status(202).json({ pair });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/pairs/:pairId/settings", async (request, response) => {
    const target = request.body?.target === "codex" || request.body?.target === "worker" ? "worker" : "butler";
    try {
      if (target === "butler") {
        const model = readString(request.body?.model);
        const level = readString(request.body?.thinkingLevel);
        if (!model && !level) {
          response.status(400).json({ error: "model or thinkingLevel is required" });
          return;
        }
        if (level && !isKnownThinkingLevel(level)) {
          response.status(400).json({ error: `thinkingLevel must be one of: off, low, medium, high, xhigh` });
          return;
        }
        try {
          const pair = model
            ? await pairSessions.setButlerModel(request.params.pairId, model)
            : await pairSessions.setButlerThinkingLevel(request.params.pairId, level);
          if (!pair) {
            response.status(404).json({ error: "Butler session not found" });
            return;
          }
          response.json({ pair });
        } catch (error) {
          response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      const model = readString(request.body?.model);
      const effort = readString(request.body?.effort);
      if (!model && !effort) {
        response.status(400).json({ error: "model or effort is required" });
        return;
      }
      if (effort && !isKnownReasoningEffort(effort)) {
        response.status(400).json({ error: "effort must be one of: minimal, low, medium, high, xhigh" });
        return;
      }
      try {
        const pair = model
          ? await pairSessions.setCodexModel(request.params.pairId, model)
          : await pairSessions.setCodexEffort(request.params.pairId, effort);
        if (!pair) {
          response.status(404).json({ error: "Butler session not found" });
          return;
        }
        response.json({ pair });
      } catch (error) {
        response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
