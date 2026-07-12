import crypto from "node:crypto";

import type { ManorRestartRequestView } from "./types.js";
import type { ManorRestartTarget } from "./host-controller-client.js";

export function createManorRestartRequest(input: {
  target?: unknown;
  gitRef?: unknown;
  includeDesktop?: unknown;
  build?: unknown;
  update?: unknown;
  reason?: unknown;
  details?: unknown;
}): ManorRestartRequestView {
  const gitRef = normalizeRestartText(input.gitRef);

  return {
    id: crypto.randomUUID(),
    target: normalizeRestartTarget(input.target),
    gitRef,
    includeDesktop: input.includeDesktop === true,
    build: normalizeOptionalRestartBoolean(input.build),
    update: normalizeOptionalRestartBoolean(input.update),
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

export function normalizeRestartTarget(value: unknown): ManorRestartTarget | null {
  return value === "current" || value === "latest" ? value : null;
}

export function normalizeOptionalRestartBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

export function requireAuthorizedManorRestartRequest(
  request: ManorRestartRequestView | null,
  requestId: string
): ManorRestartRequestView {
  if (!request || request.id !== requestId || request.status !== "authorized") {
    throw new Error("No authorized Manor restart request matches this start request.");
  }

  return request;
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

export function isManorRestartRequestWithStatus(
  value: unknown,
  status: ManorRestartRequestView["status"]
): value is ManorRestartRequestView {
  if (!value || typeof value !== "object") {
    return false;
  }
  const allowedKeys = new Set([
    "id", "target", "gitRef", "includeDesktop", "build", "update", "reason", "details",
    "requestedAt", "status", "authorizedAt"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  const request = value as Partial<ManorRestartRequestView>;
  return typeof request.id === "string" && request.status === status;
}

export function buildAuthorizedManorRestartInput(request: ManorRestartRequestView): {
  confirmation: "restart Manor";
  target: ManorRestartTarget;
  gitRef: string | null;
  includeDesktop: boolean;
  build?: boolean;
  update?: boolean;
} {
  return {
    confirmation: "restart Manor",
    target: request.target ?? "current",
    gitRef: request.gitRef,
    includeDesktop: request.includeDesktop === true,
    build: request.build ?? undefined,
    update: request.update ?? undefined
  };
}
