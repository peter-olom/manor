import path from "node:path";

import type express from "express";

import type { PairSessionManager } from "./pair-session-manager.js";
import type { WorkerSessionControlAction } from "../shared/worker-session-controls.js";

type ButlerSessionControlRouteAccess = {
  app: express.Express;
  pairSessions: PairSessionManager;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerButlerSessionControlRoutes({ app, pairSessions }: ButlerSessionControlRouteAccess): void {
  app.get("/api/pairs/:pairId/butler/controls", async (request, response) => {
    try {
      const controls = await pairSessions.getButlerSessionControls(request.params.pairId);
      if (!controls) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ controls });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/pairs/:pairId/butler/controls/:action", async (request, response) => {
    const action = request.params.action as WorkerSessionControlAction;
    if (!["compact", "abort-retry", "fork", "clone", "rename"].includes(action)) {
      response.status(404).json({ error: "Unknown Butler session action." });
      return;
    }
    try {
      const found = await pairSessions.runButlerSessionControl(request.params.pairId, action, {
        instructions: readString(request.body?.instructions),
        entryId: readString(request.body?.entryId),
        name: readString(request.body?.name)
      });
      if (!found) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.json({ ok: true });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/pairs/:pairId/butler/export", async (request, response) => {
    try {
      const exportPath = await pairSessions.exportButlerSession(request.params.pairId);
      if (!exportPath) {
        response.status(404).json({ error: "Butler session not found" });
        return;
      }
      response.download(exportPath, `${path.basename(exportPath, path.extname(exportPath))}.html`);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
