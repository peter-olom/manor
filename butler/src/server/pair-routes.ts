import type express from "express";

import { readFileReferenceIds, readImageReferenceIds } from "./server-runtime-helpers.js";
import { WorkspaceCwdError } from "./repo-worktree.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import { isKnownReasoningEffort, isKnownThinkingLevel, type PairDetail } from "../shared/pairing.js";

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

  app.get("/api/workspaces", async (_request, response) => {
    try {
      response.json({ workspaces: await pairSessions.listWorkspaces() });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs", async (request, response) => {
    try {
      const pair = await pairSessions.createPair({
        title: readString(request.body?.title) || null,
        defaultCwd: readString(request.body?.defaultCwd) || null
      });
      response.status(201).json({ pair });
    } catch (error) {
      response.status(error instanceof WorkspaceCwdError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
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

  app.get("/api/pairs/:pairId/activity-watchdogs", async (request, response) => {
    try {
      const diagnostics = await pairSessions.getActivityWatchdogs(request.params.pairId);
      if (!diagnostics) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json(diagnostics);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/pairs/:pairId/composer-suggestions", async (request, response) => {
    const trigger = request.query.trigger === "@" || request.query.trigger === "$" || request.query.trigger === "/"
      ? request.query.trigger
      : null;
    if (!trigger) {
      response.status(400).json({ error: "trigger is required" });
      return;
    }
    try {
      const suggestions = await pairSessions.listComposerSuggestions(
        request.params.pairId,
        trigger,
        typeof request.query.q === "string" ? request.query.q : ""
      );
      if (!suggestions) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ suggestions });
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

  app.post("/api/pairs/:pairId/retry-review", async (request, response) => {
    try {
      const pair = await pairSessions.retryBlockedReview(request.params.pairId);
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ pair });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/stop-review", async (request, response) => {
    try {
      const pair = await pairSessions.stopReview(request.params.pairId);
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ pair });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/worker/handoff", async (request, response) => {
    const model = readString(request.body?.model);
    const harness = readString(request.body?.harness);
    const effort = readString(request.body?.effort);
    if (!model) {
      response.status(400).json({ error: "model is required" });
      return;
    }
    if (effort && !isKnownReasoningEffort(effort)) {
      response.status(400).json({ error: "effort must be one of: none, minimal, low, medium, high, xhigh, max" });
      return;
    }
    try {
      const pair = await pairSessions.handoffWorker(request.params.pairId, model, harness || null, effort || null);
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.status(201).json({ pair });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
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

  app.patch("/api/pairs/:pairId/workspace", async (request, response) => {
    const cwd = readString(request.body?.cwd);
    if (!cwd) {
      response.status(400).json({ error: "cwd is required" });
      return;
    }
    try {
      const pair = await pairSessions.setWorkspaceCwd(request.params.pairId, cwd);
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ pair });
    } catch (error) {
      response.status(error instanceof WorkspaceCwdError ? 400 : 409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put("/api/pairs/:pairId/automation", async (request, response) => {
    const instruction = readString(request.body?.instruction);
    if (!instruction) {
      response.status(400).json({ error: "instruction is required" });
      return;
    }
    try {
      const kind = readString(request.body?.kind);
      const interval = Number.isInteger(request.body?.everyMinutes) && Number.isInteger(request.body?.durationMinutes);
      const dailyTimes = Array.isArray(request.body?.dailyTimes) ? request.body.dailyTimes : [];
      let automation;
      if (kind === "once") automation = await pairSessions.configureOnceAutomation(request.params.pairId, { instruction, on: request.body?.on, time: request.body?.time });
      else if (kind === "weekly") automation = await pairSessions.configureWeeklyAutomation(request.params.pairId, { instruction, weekdays: request.body?.weekdays, times: request.body?.times, endDate: request.body?.endDate });
      else if (kind === "window") automation = await pairSessions.configureWindowAutomation(request.params.pairId, { instruction, everyMinutes: request.body?.everyMinutes, startTime: request.body?.startTime, endTime: request.body?.endTime, endDate: request.body?.endDate });
      else if (interval) automation = await pairSessions.configureIntervalAutomation(request.params.pairId, { instruction, everyMinutes: request.body.everyMinutes, durationMinutes: request.body.durationMinutes });
      else {
        if (dailyTimes.length === 0) throw new Error("Provide a supported schedule kind or dailyTimes");
        automation = await pairSessions.configureAutomation(request.params.pairId, { instruction, dailyTimes, endDate: request.body?.endDate });
      }
      if (!automation) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ automation });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/pairs/:pairId/automation", async (request, response) => {
    if (typeof request.body?.enabled !== "boolean") {
      response.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    try {
      const automation = await pairSessions.setAutomationEnabled(request.params.pairId, request.body.enabled);
      if (!automation) {
        response.status(404).json({ error: "Session automation not found" });
        return;
      }
      response.json({ automation });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/pairs/:pairId/automation", async (request, response) => {
    try {
      if (!await pairSessions.deleteAutomation(request.params.pairId)) {
        response.status(404).json({ error: "Session automation not found" });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/pairs/:pairId/worker-thread", async (request, response) => {
    try {
      const before = readLimit(request.query.before, NaN);
      const limit = readLimit(request.query.limit, 10);
      response.json(await pairSessions.getWorkerThreadPage(
        request.params.pairId,
        Number.isFinite(before) ? before : null,
        limit
      ));
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/messages", async (request, response) => {
    const text = readString(request.body?.text);
    const target = request.body?.target === "worker" ? "worker" : "butler";
    const imageReferenceIds = readImageReferenceIds(request.body);
    const fileReferenceIds = readFileReferenceIds(request.body);
    const inputItems = Array.isArray(request.body?.inputItems) ? request.body.inputItems : [];
    if (target === "worker") {
      response.status(409).json({ error: "Message Butler. Butler controls the worker for this session." });
      return;
    }
    if (!text && imageReferenceIds.length === 0 && fileReferenceIds.length === 0 && inputItems.length === 0) {
      response.status(400).json({ error: "text, attachments, or context are required" });
      return;
    }

    try {
      const pair = await pairSessions.sendOperatorMessage({
        pairId: request.params.pairId,
        text,
        imageReferenceIds,
        fileReferenceIds,
        inputItems
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

  app.post("/api/pairs/:pairId/operator-question-answer", async (request, response) => {
    const messageId = readString(request.body?.messageId);
    const questionId = readString(request.body?.questionId);
    const optionId = readString(request.body?.optionId);
    const freeformText = readString(request.body?.freeformText);
    if (!messageId || !questionId || Boolean(optionId) === Boolean(freeformText)) {
      response.status(400).json({ error: "messageId, questionId, and exactly one answer are required" });
      return;
    }

    try {
      const pair = await pairSessions.answerOperatorQuestion({
        pairId: request.params.pairId,
        messageId,
        questionId,
        optionId: optionId || undefined,
        freeformText: freeformText || undefined
      });
      if (!pair) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.status(202).json({ pair });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
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
          response.status(400).json({ error: `thinkingLevel must be one of: off, none, minimal, low, medium, high, xhigh, max` });
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
      const harness = readString(request.body?.harness);
      const effort = readString(request.body?.effort);
      if (!model && !effort) {
        response.status(400).json({ error: "model or effort is required" });
        return;
      }
      if (effort && !isKnownReasoningEffort(effort)) {
        response.status(400).json({ error: "effort must be one of: none, minimal, low, medium, high, xhigh, max" });
        return;
      }
      try {
        let pair: PairDetail | null = null;
        if (model) {
          pair = await pairSessions.setWorkerModel(request.params.pairId, model, harness || null);
        } else if (effort) {
          pair = await pairSessions.setWorkerEffort(request.params.pairId, effort);
        }
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
