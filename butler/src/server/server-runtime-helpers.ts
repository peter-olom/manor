import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Response } from "express";

import type { ButlerAgentService } from "./butler-agent.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ServiceTemplateRegistry } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type { StackStorageMode } from "./types.js";
import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";

type RuntimeServerAccess = {
  artifactsDir: string;
  butlerAgent: ButlerAgentService;
  codexClient: CodexAppServerClient;
  runtimeBroker: RuntimeBrokerClient;
  runtimeBrokerUrl: string;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  store: ButlerStateStore;
};

export function resolvePreviewProxyTarget(access: RuntimeServerAccess, leaseId: string): string | null {
  const lease = access.store.getPreviewLease(leaseId);
  if (!lease || lease.status === "stopped" || lease.status === "stopping") {
    return null;
  }

  return access.runtimeBrokerUrl;
}

function currentShellSnapshot(access: RuntimeServerAccess) {
  return access.store.getShellSnapshot(access.butlerAgent.getShellSnapshot(), {
    ...access.codexClient.getConnectionState(),
    auth: access.butlerAgent.getCodexAuthStatus()
  });
}

function currentButlerLiveSnapshot(access: RuntimeServerAccess) {
  return access.butlerAgent.getLiveSnapshot();
}

function currentRuntimeSnapshot(access: RuntimeServerAccess) {
  return access.store.getRuntimeSnapshot(access.serviceTemplateRegistry.list());
}

function currentOpenThreadsSnapshot(access: RuntimeServerAccess) {
  return access.store.listOpenThreadDetails();
}

export function currentBootstrapSnapshot(access: RuntimeServerAccess) {
  return {
    shell: currentShellSnapshot(access),
    butlerLive: currentButlerLiveSnapshot(access),
    runtime: currentRuntimeSnapshot(access),
    openThreads: currentOpenThreadsSnapshot(access)
  };
}

export function shouldAllowLocalThreadWindow(access: RuntimeServerAccess, threadId: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const retryable = message.includes("failed to locate rollout") || message.includes("thread not found") || message.includes("thread not loaded");
  return retryable && Boolean(access.store.getThread(threadId));
}

export class ButlerSseHub {
  readonly heartbeatMs: number;
  private readonly clients = new Set<Response>();
  private readonly broadcastCache = {
    shell: "",
    butlerLive: "",
    runtime: "",
    threads: ""
  };
  private broadcastTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly access: RuntimeServerAccess,
    options?: {
      heartbeatMs?: number;
      broadcastDebounceMs?: number;
    }
  ) {
    this.heartbeatMs = options?.heartbeatMs ?? 15000;
    this.broadcastDebounceMs = options?.broadcastDebounceMs ?? 24;
  }

  private readonly broadcastDebounceMs: number;

  addClient(response: Response): void {
    this.clients.add(response);
  }

  removeClient(response: Response): void {
    this.clients.delete(response);
  }

  writeEvent(response: Response, eventName: string, payload: unknown): void {
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  broadcastToast(message: string, tone: "success" | "error" | "info" = "info", duration = 4000): void {
    const payload = {
      id: crypto.randomUUID(),
      message,
      tone,
      duration
    };

    for (const client of this.clients) {
      this.writeEvent(client, "toast", payload);
    }
  }

  sendInitialEvents(response: Response): void {
    this.writeEvent(response, "shell", currentShellSnapshot(this.access));
    this.writeEvent(response, "butlerLive", currentButlerLiveSnapshot(this.access));
    this.writeEvent(response, "runtime", currentRuntimeSnapshot(this.access));
    this.writeEvent(response, "threads", currentOpenThreadsSnapshot(this.access));
  }

  flush(force = false): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }

    const shell = currentShellSnapshot(this.access);
    const butlerLive = currentButlerLiveSnapshot(this.access);
    const runtime = currentRuntimeSnapshot(this.access);
    const threads = currentOpenThreadsSnapshot(this.access);

    const nextPayloads = {
      shell: JSON.stringify(shell),
      butlerLive: JSON.stringify(butlerLive),
      runtime: JSON.stringify(runtime),
      threads: JSON.stringify(threads)
    };

    for (const client of this.clients) {
      if (force || nextPayloads.shell !== this.broadcastCache.shell) {
        this.writeEvent(client, "shell", shell);
      }
      if (force || nextPayloads.butlerLive !== this.broadcastCache.butlerLive) {
        this.writeEvent(client, "butlerLive", butlerLive);
      }
      if (force || nextPayloads.runtime !== this.broadcastCache.runtime) {
        this.writeEvent(client, "runtime", runtime);
      }
      if (force || nextPayloads.threads !== this.broadcastCache.threads) {
        this.writeEvent(client, "threads", threads);
      }
    }

    this.broadcastCache.shell = nextPayloads.shell;
    this.broadcastCache.butlerLive = nextPayloads.butlerLive;
    this.broadcastCache.runtime = nextPayloads.runtime;
    this.broadcastCache.threads = nextPayloads.threads;
  }

  schedule(): void {
    if (this.broadcastTimer !== null) {
      return;
    }

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.flush();
    }, this.broadcastDebounceMs);
  }
}

function matchStackSelector<T extends { id: string; title: string }>(stacks: T[], selector: string): T | null {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) {
    return null;
  }

  const directIdMatch = stacks.find((stack) => stack.id === normalizedSelector);
  if (directIdMatch) {
    return directIdMatch;
  }

  const exactTitleMatches = stacks.filter((stack) => stack.title === normalizedSelector);
  if (exactTitleMatches.length === 1) {
    return exactTitleMatches[0];
  }

  const foldedSelector = normalizedSelector.toLowerCase();
  const foldedTitleMatches = stacks.filter((stack) => stack.title.trim().toLowerCase() === foldedSelector);
  if (foldedTitleMatches.length === 1) {
    return foldedTitleMatches[0];
  }

  return null;
}

export function resolveProjectMetadata(cwd: string | null | undefined, fallbackId: string, fallbackLabel: string) {
  const project = resolveWorkspaceProjectInfo(cwd);
  if (project.id === "unknown") {
    return {
      id: fallbackId,
      label: fallbackLabel
    };
  }
  return project;
}

async function resolveRequestedStack(
  access: RuntimeServerAccess,
  stackSelector: string | null,
  threadId: string | null
): Promise<{ id: string; threadId: string | null; worktreePath: string | null; title: string; storageMode: StackStorageMode } | null> {
  if (!stackSelector) {
    return null;
  }

  const visibleStacks = access.store
    .listStackLeases()
    .filter((stack) => !threadId || stack.threadId === threadId || !stack.threadId);
  const storedMatch = matchStackSelector(visibleStacks, stackSelector);
  if (storedMatch) {
    return storedMatch;
  }

  const brokerMatch = matchStackSelector(await access.runtimeBroker.listStacks(threadId), stackSelector);
  if (brokerMatch) {
    access.store.upsertStackLease(brokerMatch);
    return brokerMatch;
  }

  const stack = await access.runtimeBroker.inspectStack(stackSelector);
  access.store.upsertStackLease(stack);
  return stack;
}

export async function validateRequestedStack(access: RuntimeServerAccess, stackId: string | null, threadId: string | null) {
  const stack = await resolveRequestedStack(access, stackId, threadId);
  if (!stack) {
    return null;
  }

  if (threadId && stack.threadId && stack.threadId !== threadId) {
    throw new Error(`Stack ${stack.id} belongs to a different job`);
  }

  return stack;
}

export function removeStackArtifactsFromStore(access: RuntimeServerAccess, stackId: string): void {
  for (const lease of access.store.listPreviewLeases()) {
    if (lease.stackId === stackId) {
      access.store.removePreviewLease(lease.id);
    }
  }

  for (const lease of access.store.listServiceLeases()) {
    if (lease.stackId === stackId) {
      access.store.removeServiceLease(lease.id);
    }
  }

  access.store.removeStackLease(stackId);
}

function isIgnorableRuntimeCleanupError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("not found");
}

export async function cleanupThreadRuntimeResources(
  access: RuntimeServerAccess,
  context: {
    threadId: string;
    stacks: Array<{ id: string; retainsVolumes: boolean; status: string }>;
    previews: Array<{ id: string; stackId: string | null; status: string }>;
    services: Array<{ id: string; stackId: string | null; runtimeKind: string; status: string }>;
  }
): Promise<void> {
  const threadId = context.threadId;
  const storedStacks = context.stacks.filter((lease) => lease.status !== "stopped");
  const storedPreviews = context.previews.filter((lease) => lease.status !== "stopped");
  const storedServices = context.services.filter((lease) => lease.status !== "stopped");

  const [brokerStacks, brokerPreviews, brokerServices] = await Promise.all([
    access.runtimeBroker.listStacks(threadId),
    access.runtimeBroker.listLeases(threadId),
    access.runtimeBroker.listServices(threadId)
  ]);

  const stacksById = new Map([...storedStacks, ...brokerStacks].map((lease) => [lease.id, lease]));
  const stackIds = new Set(stacksById.keys());

  for (const stack of stacksById.values()) {
    try {
      await access.runtimeBroker.stopStack(stack.id, { dropVolumes: Boolean(stack.retainsVolumes) });
    } catch (error) {
      if (!isIgnorableRuntimeCleanupError(error)) {
        throw error;
      }
    }
  }

  const previewsById = new Map(
    [...storedPreviews, ...brokerPreviews]
      .filter((lease) => !lease.stackId || !stackIds.has(lease.stackId))
      .map((lease) => [lease.id, lease])
  );

  for (const preview of previewsById.values()) {
    try {
      await access.runtimeBroker.stopLease(preview.id);
    } catch (error) {
      if (!isIgnorableRuntimeCleanupError(error)) {
        throw error;
      }
    }
  }

  const servicesById = new Map(
    [...storedServices, ...brokerServices]
      .filter((service) => service.runtimeKind === "container")
      .filter((service) => !service.stackId || !stackIds.has(service.stackId))
      .map((service) => [service.id, service])
  );

  for (const service of servicesById.values()) {
    try {
      await access.runtimeBroker.stopService(service.id);
    } catch (error) {
      if (!isIgnorableRuntimeCleanupError(error)) {
        throw error;
      }
    }
  }
}

export function readImageReferenceIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("imageReferenceIds" in body)) {
    return [];
  }

  const value = (body as { imageReferenceIds?: unknown }).imageReferenceIds;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function decodeArtifactRelativePath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join(path.sep);
}

export async function pruneEmptyArtifactParents(artifactsDir: string, startPath: string): Promise<void> {
  let currentPath = path.dirname(startPath);
  while (currentPath.startsWith(`${artifactsDir}${path.sep}`)) {
    try {
      const entries = await fs.readdir(currentPath);
      if (entries.length > 0) {
        return;
      }
      await fs.rmdir(currentPath);
      currentPath = path.dirname(currentPath);
    } catch {
      return;
    }
  }
}

export function sendUnavailableArtifactResponse(
  response: Response,
  availability: "expired" | "missing",
  artifact: {
    label: string;
    fileName: string;
    retainedUntilAt: number | null;
    expiredAt: number | null;
  }
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return;
  }

  const expired = availability === "expired";
  const message = expired
    ? "Artifact expired after the 14 day retention window."
    : "Artifact metadata is still available, but the file itself is no longer present.";
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Artifact-Availability", availability);
  response.setHeader("X-Artifact-Error", message);
  response.status(410).json({
    error: message,
    availability,
    label: artifact.label,
    fileName: artifact.fileName,
    retainedUntilAt: artifact.retainedUntilAt,
    expiredAt: artifact.expiredAt
  });
}

export type { RuntimeServerAccess };
