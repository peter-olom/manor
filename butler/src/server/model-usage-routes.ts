import type express from "express";

import type { ModelUsageStore } from "./model-usage-store.js";
import type { ModelUsageRange } from "../shared/model-usage.js";

function range(value: unknown): ModelUsageRange {
  return value === "30d" || value === "all" ? value : "7d";
}

export function registerModelUsageRoutes(app: express.Express, store: ModelUsageStore): void {
  app.get("/api/model-usage", async (request, response) => {
    try {
      response.json(await store.get(range(request.query.range)));
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/model-usage/reset", async (_request, response) => {
    try {
      response.json({ resetAt: await store.reset() });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
