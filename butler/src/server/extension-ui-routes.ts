import type express from "express";

import type { ExtensionUiBroker } from "./extension-ui-broker.js";
import type { PairStore } from "./pair-store.js";
import type { ExtensionUiDialogResponse, ExtensionUiLane } from "../shared/extension-ui.js";

type ExtensionUiRouteAccess = {
  app: express.Express;
  pairStore: PairStore;
  broker: ExtensionUiBroker;
};

function scopesForPair(access: ExtensionUiRouteAccess, pairId: string) {
  const pair = access.pairStore.getPair(pairId);
  if (!pair) return null;
  return [
    { scope: `butler:${pairId}`, lane: "butler" as const },
    ...(pair.worker?.runtime === "pi-rpc" ? [{ scope: pair.worker.threadId, lane: "worker" as const }] : [])
  ];
}

function scopeForLane(scopes: Array<{ scope: string; lane: ExtensionUiLane }>, lane: ExtensionUiLane): string | null {
  return scopes.find((entry) => entry.lane === lane)?.scope ?? null;
}

function readResponse(value: unknown): ExtensionUiDialogResponse | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.cancelled === true) return { cancelled: true };
  if (typeof input.confirmed === "boolean") return { confirmed: input.confirmed };
  if (typeof input.value === "string") return { value: input.value };
  return null;
}

export function registerExtensionUiRoutes(access: ExtensionUiRouteAccess): void {
  access.app.get("/api/pairs/:pairId/extension-ui", (request, response) => {
    const scopes = scopesForPair(access, request.params.pairId);
    if (!scopes) {
      response.status(404).json({ error: "Butler session not found" });
      return;
    }
    response.json({ extensionUi: access.broker.view(scopes) });
  });

  access.app.post("/api/pairs/:pairId/extension-ui/respond", (request, response) => {
    const scopes = scopesForPair(access, request.params.pairId);
    if (!scopes) {
      response.status(404).json({ error: "Butler session not found" });
      return;
    }
    const requestId = typeof request.body?.requestId === "string" ? request.body.requestId : "";
    const dialog = access.broker.view(scopes).dialog;
    const result = readResponse(request.body?.response);
    if (!dialog || dialog.id !== requestId || !result) {
      response.status(409).json({ error: "This extension request is no longer active." });
      return;
    }
    const scope = scopeForLane(scopes, dialog.lane);
    if (!scope || !access.broker.respond(scope, requestId, result)) {
      response.status(409).json({ error: "This extension request is no longer active." });
      return;
    }
    response.json({ ok: true });
  });

  access.app.post("/api/pairs/:pairId/extension-ui/dismiss", (request, response) => {
    const scopes = scopesForPair(access, request.params.pairId);
    if (!scopes) {
      response.status(404).json({ error: "Butler session not found" });
      return;
    }
    const itemId = typeof request.body?.itemId === "string" ? request.body.itemId : "";
    const view = access.broker.view(scopes);
    const item = view.notices.find((entry) => entry.id === itemId) ?? (view.editorText?.id === itemId ? view.editorText : null);
    if (!item) {
      response.status(409).json({ error: "This extension item is no longer active." });
      return;
    }
    const scope = scopeForLane(scopes, item.lane);
    response.json({ ok: Boolean(scope && access.broker.dismiss(scope, itemId)) });
  });
}
