import type { Express } from "express";

import { isRestartAuthorizeAction } from "./manor-restart-authorization.js";
import type { ManorRestartRequestView } from "./types.js";

type ManorRestartRouteAgent = {
  requestManorRestartAuthorization(input: {
    targetCommit?: unknown;
    targetTag?: unknown;
    reason?: unknown;
    details?: unknown;
  }): ManorRestartRequestView;
  authorizeManorRestartRequest(requestId: string): ManorRestartRequestView;
  dismissManorRestartRequest(requestId: string): void;
};

export function registerManorRestartRoutes(app: Express, butlerAgent: ManorRestartRouteAgent): void {
  app.post("/api/manor/restart-requests", (request, response) => {
    try {
      const restartRequest = butlerAgent.requestManorRestartAuthorization(request.body ?? {});
      response.status(202).json({ ok: true, restartRequest });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/manor/restart-requests/:requestId/authorize", (request, response) => {
    try {
      requireAuthorizeAction(request.body?.operatorAction);
      response.json({ ok: true, restartRequest: butlerAgent.authorizeManorRestartRequest(readRequestId(request.params.requestId)) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/manor/restart-requests/:requestId/dismiss", (request, response) => {
    try {
      butlerAgent.dismissManorRestartRequest(readRequestId(request.params.requestId));
      response.json({ ok: true });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function readRequestId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("requestId is required");
  }

  return value.trim();
}

function requireAuthorizeAction(value: unknown): void {
  if (!isRestartAuthorizeAction(value)) {
    throw new Error("Restart authorization requires the explicit Authorize restart action.");
  }
}
