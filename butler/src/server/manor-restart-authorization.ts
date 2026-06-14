import crypto from "node:crypto";

import type { ManorRestartRequestView } from "./types.js";
import type { ManorRestartMode, ManorRestartTarget } from "./host-controller-client.js";

export function createManorRestartRequest(input: {
  mode?: unknown;
  target?: unknown;
  gitRef?: unknown;
  imageTag?: unknown;
  targetCommit?: unknown;
  targetTag?: unknown;
  includeDesktop?: unknown;
  build?: unknown;
  update?: unknown;
  reason?: unknown;
  details?: unknown;
}): ManorRestartRequestView {
  const gitRef = normalizeRestartText(input.gitRef);
  const imageTag = normalizeRestartText(input.imageTag);
  const targetCommit = normalizeRestartText(input.targetCommit);
  const targetTag = normalizeRestartText(input.targetTag);

  return {
    id: crypto.randomUUID(),
    mode: normalizeRestartMode(input.mode),
    target: normalizeRestartTarget(input.target),
    gitRef: gitRef ?? targetCommit,
    imageTag: imageTag ?? targetTag,
    targetCommit,
    targetTag,
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

export function normalizeRestartMode(value: unknown): ManorRestartMode | null {
  return value === "auto" || value === "source" || value === "image" ? value : null;
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
  const request = value as Partial<ManorRestartRequestView>;
  return typeof request.id === "string" && request.status === status;
}

export function buildAuthorizedManorRestartInput(request: ManorRestartRequestView): {
  confirmation: "restart Manor";
  mode: ManorRestartMode;
  target: ManorRestartTarget;
  gitRef: string | null;
  imageTag: string | null;
  includeDesktop: boolean;
  build?: boolean;
  update?: boolean;
} {
  const gitRef = request.gitRef ?? request.targetCommit;
  const imageTag = request.imageTag ?? request.targetTag;
  const mode = request.mode ?? (gitRef ? "source" : imageTag ? "image" : "auto");
  return {
    confirmation: "restart Manor",
    mode,
    target: request.target ?? "current",
    gitRef,
    imageTag,
    includeDesktop: request.includeDesktop === true,
    build: mode === "source" || mode === "auto" ? request.build ?? undefined : undefined,
    update: request.update ?? undefined
  };
}
