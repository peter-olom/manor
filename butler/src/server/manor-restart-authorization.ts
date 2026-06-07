import crypto from "node:crypto";

import type { ManorRestartRequestView } from "./types.js";

export function createManorRestartRequest(input: {
  targetCommit?: unknown;
  targetTag?: unknown;
  reason?: unknown;
  details?: unknown;
}): ManorRestartRequestView {
  return {
    id: crypto.randomUUID(),
    targetCommit: normalizeRestartText(input.targetCommit),
    targetTag: normalizeRestartText(input.targetTag),
    reason: normalizeRestartText(input.reason),
    details: normalizeRestartText(input.details),
    requestedAt: Date.now(),
    status: "pending",
    authorizedAt: null
  };
}

export function normalizeRestartText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function authorizeManorRestartRequest(
  request: ManorRestartRequestView | null,
  requestId: string
): ManorRestartRequestView {
  if (!request || request.id !== requestId || request.status !== "pending") {
    throw new Error("No pending Manor restart request matches this authorization.");
  }

  return { ...request, status: "authorized", authorizedAt: Date.now() };
}

export function requirePendingManorRestartRequest(
  request: ManorRestartRequestView | null,
  requestId: string,
  action: "authorization" | "dismissal"
): ManorRestartRequestView {
  if (!request || request.id !== requestId || request.status !== "pending") {
    throw new Error(`No pending Manor restart request matches this ${action}.`);
  }

  return request;
}

export function isRestartAuthorizeAction(value: unknown): boolean {
  return value === "authorize_restart";
}
