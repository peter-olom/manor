import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Express } from "express";

import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import {
  removeStackArtifactsFromStore,
  resolveProjectMetadata,
  type RuntimeServerAccess,
  validateRequestedStack
} from "./server-runtime-helpers.js";
import { type ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ServiceLeaseView, StackLeaseView } from "./types.js";
import { applyWorkspacePreviewDefaults, inspectWorkspaceBootstrap } from "./workspace-bootstrap.js";

export type RuntimeResourceRoutesAccess = {
  app: Express;
  runtimeAccess: RuntimeServerAccess;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
  store: ButlerStateStore;
  applyServiceStartedPoliciesForServer: (service: ServiceLeaseView, stack: Pick<StackLeaseView, "storageMode"> | null) => Promise<unknown>;
};

function normalizeLeaseTtlMs(leaseTtlMinutes: unknown): number | null {
  const numeric = typeof leaseTtlMinutes === "number" ? leaseTtlMinutes : Number(leaseTtlMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(60_000, Math.trunc(numeric * 60_000));
}

function applyRequestedLeaseLifecycle<T extends object>(
  lease: T,
  requestBody: { sticky?: unknown; leaseTtlMinutes?: unknown }
): T & { pinned?: boolean; leaseTtlMs?: number | null } {
  const sticky = typeof requestBody.sticky === "boolean" ? requestBody.sticky : undefined;
  const leaseTtlMs = normalizeLeaseTtlMs(requestBody.leaseTtlMinutes);
  return {
    ...lease,
    ...(typeof sticky === "boolean" ? { pinned: sticky } : {}),
    ...(leaseTtlMs !== null ? { leaseTtlMs } : {})
  };
}

export function registerRuntimeResourceRoutes(access: RuntimeResourceRoutesAccess): void {
  const { app, runtimeAccess, runtimeBroker, serviceTemplateRegistry, store, applyServiceStartedPoliciesForServer } = access;

app.post("/api/stacks/start", async (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const storageMode = typeof request.body?.storageMode === "string" ? request.body.storageMode.trim() : "";
    const retainsVolumes = Boolean(request.body?.retainsVolumes);
    const storageKey = typeof request.body?.storageKey === "string" ? request.body.storageKey.trim() : "";
    const cloneFromStorageKey =
      typeof request.body?.cloneFromStorageKey === "string" ? request.body.cloneFromStorageKey.trim() : "";
    if (!title) {
      response.status(400).json({ error: "title is required" });
      return;
    }
  
    try {
      const thread = threadId ? store.getThread(threadId) ?? null : null;
      const worktreePath = cwd || thread?.cwd || null;
      const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "stack", thread?.supervisor.projectLabel ?? "stack");
      const stack = applyRequestedLeaseLifecycle(await runtimeBroker.createStack({
        stackId: crypto.randomUUID(),
        threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        worktreePath,
        storageMode: storageMode || null,
        retainsVolumes,
        storageKey: storageKey || null,
        cloneFromStorageKey: cloneFromStorageKey || null
      }), request.body ?? {});
      store.upsertStackLease(stack);
      response.json({ ok: true, stack });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/stacks/stop", async (request, response) => {
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId : "";
    const dropVolumes = typeof request.body?.dropVolumes === "boolean" ? request.body.dropVolumes : true;
    if (!stackId) {
      response.status(400).json({ error: "stackId is required" });
      return;
    }
  
    try {
      await runtimeBroker.stopStack(stackId, { dropVolumes });
      removeStackArtifactsFromStore(runtimeAccess, stackId);
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/stacks/promote", async (request, response) => {
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
    const targetStorageKey =
      typeof request.body?.targetStorageKey === "string" ? request.body.targetStorageKey.trim() : "";
    if (!stackId) {
      response.status(400).json({ error: "stackId is required" });
      return;
    }
  
    try {
      const result = await runtimeBroker.promoteStack({
        stackId,
        targetStorageKey: targetStorageKey || null
      });
      const stack = await runtimeBroker.inspectStack(stackId);
      store.upsertStackLease(stack);
      response.json({ ok: true, promotion: result, stack });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/stacks/pin", (request, response) => {
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId : "";
    const pinned = Boolean(request.body?.pinned);
    if (!stackId) {
      response.status(400).json({ error: "stackId is required" });
      return;
    }
  
    const stack = store.setStackLeasePinned(stackId, pinned);
    if (!stack) {
      response.status(404).json({ error: "Stack lease not found" });
      return;
    }
  
    response.json({ ok: true, stack });
  });
  
  app.post("/api/stacks/lease", (request, response) => {
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId : "";
    const sticky = typeof request.body?.sticky === "boolean" ? request.body.sticky : undefined;
    const leaseTtlMs = request.body?.leaseTtlMinutes === undefined ? undefined : normalizeLeaseTtlMs(request.body?.leaseTtlMinutes);
    const refresh = request.body?.refresh !== false;
    if (!stackId) {
      response.status(400).json({ error: "stackId is required" });
      return;
    }
  
    const stack = store.setStackLeaseLifecycle(stackId, {
      pinned: sticky,
      leaseTtlMs,
      refresh
    });
    if (!stack) {
      response.status(404).json({ error: "Stack lease not found" });
      return;
    }
  
    response.json({ ok: true, stack });
  });
  
  app.post("/api/previews/start", async (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
    const portValue = typeof request.body?.port === "number" ? request.body.port : Number(request.body?.port ?? 0);
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
    const aliases = Array.isArray(request.body?.aliases)
      ? request.body.aliases
          .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
          .filter((value: string) => value.length > 0)
      : [];
    const env =
      request.body?.env && typeof request.body.env === "object"
        ? Object.fromEntries(
            Object.entries(request.body.env as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
              .map(([key, value]) => [key.trim(), value.trim()])
              .filter(([key, value]) => key && value)
          )
        : {};
    const image = typeof request.body?.image === "string" ? request.body.image.trim() : undefined;
    const egressDomains = Array.isArray(request.body?.egressDomains)
      ? request.body.egressDomains
          .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
          .filter((value: string) => value.length > 0)
      : [];
    const egressProfile =
      typeof request.body?.egressProfile === "string" && request.body.egressProfile.trim()
        ? request.body.egressProfile.trim()
        : "internet";
    const bootstrapWaitSeconds =
      typeof request.body?.bootstrapWaitSeconds === "number"
        ? request.body.bootstrapWaitSeconds
        : Number(request.body?.bootstrapWaitSeconds ?? 0);
    const bootstrapHint = typeof request.body?.bootstrapHint === "string" ? request.body.bootstrapHint.trim() : "";
    const heartbeatKind =
      typeof request.body?.heartbeatKind === "string" && request.body.heartbeatKind.trim()
        ? request.body.heartbeatKind.trim()
        : "";
    const heartbeatTarget = typeof request.body?.heartbeatTarget === "string" ? request.body.heartbeatTarget.trim() : "";
    const heartbeatIntervalSeconds =
      typeof request.body?.heartbeatIntervalSeconds === "number"
        ? request.body.heartbeatIntervalSeconds
        : Number(request.body?.heartbeatIntervalSeconds ?? 0);
    const workspaceMode = "snapshot";
  
    try {
      const thread = threadId ? store.getThread(threadId) ?? null : null;
      const requestedStack = await validateRequestedStack(runtimeAccess, stackId || null, threadId);
      const worktreePath = cwd || requestedStack?.worktreePath || thread?.cwd || "";
      const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "preview", thread?.supervisor.projectLabel ?? "preview");
      const workspaceBootstrap = await inspectWorkspaceBootstrap(worktreePath);
  
      if (!title || !worktreePath || !command || !Number.isFinite(portValue) || portValue <= 0) {
        response.status(400).json({ error: "title, cwd, command, and port are required" });
        return;
      }
  
      const previewDefaults = applyWorkspacePreviewDefaults(
        {
          image,
          egressProfile,
          egressDomains,
          bootstrapHint: bootstrapHint || undefined
        },
        workspaceBootstrap
      );
  
      const lease = applyRequestedLeaseLifecycle(await runtimeBroker.createLease({
        leaseId: crypto.randomUUID(),
        threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        stackId: requestedStack?.id ?? null,
        aliases,
        worktreePath,
        branchName: null,
        targetPort: portValue,
        command,
        workspaceMode,
        image: previewDefaults.image,
        egressProfile: previewDefaults.egressProfile ?? "internet",
        egressDomains: previewDefaults.egressDomains ?? [],
        bootstrapWaitSeconds: Number.isFinite(bootstrapWaitSeconds) && bootstrapWaitSeconds > 0 ? bootstrapWaitSeconds : undefined,
        bootstrapHint: previewDefaults.bootstrapHint,
        heartbeatKind: heartbeatKind || undefined,
        heartbeatTarget: heartbeatTarget || undefined,
        heartbeatIntervalSeconds:
          Number.isFinite(heartbeatIntervalSeconds) && heartbeatIntervalSeconds > 0 ? heartbeatIntervalSeconds : undefined,
        env
      }), request.body ?? {});
      store.upsertPreviewLease(lease);
      response.json({ ok: true, lease, workspaceBootstrap, previewDefaults });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/previews/stop", async (request, response) => {
    const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
    if (!leaseId) {
      response.status(400).json({ error: "leaseId is required" });
      return;
    }
  
    try {
      store.markPreviewLeaseStopping(leaseId);
      await runtimeBroker.stopLease(leaseId);
      store.removePreviewLease(leaseId);
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/previews/pin", (request, response) => {
    const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
    const pinned = Boolean(request.body?.pinned);
    if (!leaseId) {
      response.status(400).json({ error: "leaseId is required" });
      return;
    }
  
    const lease = store.setPreviewLeasePinned(leaseId, pinned);
    if (!lease) {
      response.status(404).json({ error: "Preview lease not found" });
      return;
    }
  
    response.json({ ok: true, lease });
  });
  
  app.post("/api/previews/lease", (request, response) => {
    const leaseId = typeof request.body?.leaseId === "string" ? request.body.leaseId : "";
    const sticky = typeof request.body?.sticky === "boolean" ? request.body.sticky : undefined;
    const leaseTtlMs = request.body?.leaseTtlMinutes === undefined ? undefined : normalizeLeaseTtlMs(request.body?.leaseTtlMinutes);
    const refresh = request.body?.refresh !== false;
    if (!leaseId) {
      response.status(400).json({ error: "leaseId is required" });
      return;
    }
  
    const lease = store.setPreviewLeaseLifecycle(leaseId, {
      pinned: sticky,
      leaseTtlMs,
      refresh
    });
    if (!lease) {
      response.status(404).json({ error: "Preview lease not found" });
      return;
    }
  
    response.json({ ok: true, lease });
  });
  
  app.post("/api/services/start", async (request, response) => {
    const templateId = typeof request.body?.templateId === "string" ? request.body.templateId.trim() : "";
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd.trim() : "";
    const stackId = typeof request.body?.stackId === "string" ? request.body.stackId.trim() : "";
    const aliases = Array.isArray(request.body?.aliases)
      ? request.body.aliases
          .map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
          .filter((value: string) => value.length > 0)
      : [];
    const env =
      request.body?.env && typeof request.body.env === "object"
        ? Object.fromEntries(
            Object.entries(request.body.env as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
              .map(([key, value]) => [key.trim(), value.trim()])
              .filter(([key, value]) => key && value)
          )
        : {};
  
    const template = serviceTemplateRegistry.get(templateId);
    if (!template) {
      response.status(400).json({ error: `Unknown service template: ${templateId}` });
      return;
    }
  
    try {
      const thread = threadId ? store.getThread(threadId) ?? null : null;
      const requestedStack = await validateRequestedStack(runtimeAccess, stackId || null, threadId);
      const serviceId = crypto.randomUUID();
      const mergedEnv = { ...template.envDefaults, ...env };
      const effectiveTitle = title || `${template.label} ${serviceId.slice(0, 8)}`;
      const worktreePath = cwd || requestedStack?.worktreePath || thread?.cwd || "/repos";
      const project = resolveProjectMetadata(worktreePath, thread?.supervisor.projectId ?? "service", thread?.supervisor.projectLabel ?? "service");
  
      if (template.runtimeKind === "embedded") {
        const relativePath = template.fileName ?? ".manor/sqlite/app.db";
        const absolutePath = path.join(worktreePath, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const handle = await fs.open(absolutePath, "a");
        await handle.close();
  
        const now = Date.now();
        const lease = toServiceLeaseView({
          id: serviceId,
          threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: effectiveTitle,
          stackId: requestedStack?.id ?? null,
          aliases,
          template,
          containerName: `embedded-${serviceId}`,
          targetHost: "local-file",
          targetPort: 0,
          worktreePath: absolutePath,
          status: "running",
          createdAt: now,
          updatedAt: now,
          lastError: null,
          env: mergedEnv
        });
        store.upsertServiceLease(lease);
        const policyApplications = await applyServiceStartedPoliciesForServer(lease, requestedStack);
        response.json({ ok: true, service: lease, policyApplications });
        return;
      }
  
      const service = await runtimeBroker.createService({
        serviceId,
        threadId,
        projectId: project.id,
        projectLabel: project.label,
        title: effectiveTitle,
        stackId: requestedStack?.id ?? null,
        aliases,
        templateId: template.id,
        templateLabel: template.label,
        runtimeKind: template.runtimeKind,
        worktreePath,
        targetPort: template.defaultPort,
        image: template.image,
        command: template.command,
        workingDir: template.workingDir,
        stackVolumePath: template.stackVolumePath,
        env: mergedEnv
      });
      const lease = toServiceLeaseView({
        id: service.id,
        threadId: service.threadId,
        projectId: service.projectId,
        projectLabel: service.projectLabel,
        title: service.title,
        stackId: service.stackId,
        aliases: service.aliases,
        template,
        containerName: service.containerName,
        targetHost: service.targetHost,
        targetPort: service.targetPort,
        worktreePath: service.worktreePath,
        status: service.status,
        storageKind: service.storageKind,
        sticky: service.sticky,
        volumeName: service.volumeName,
        volumeMountPath: service.volumeMountPath,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        lastError: service.lastError,
        env: service.env
      });
      store.upsertServiceLease(lease);
      const policyApplications = await applyServiceStartedPoliciesForServer(lease, requestedStack);
      response.json({ ok: true, service: lease, policyApplications });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/services/stop", async (request, response) => {
    const serviceId = typeof request.body?.serviceId === "string" ? request.body.serviceId : "";
    if (!serviceId) {
      response.status(400).json({ error: "serviceId is required" });
      return;
    }
  
    const lease = store.getServiceLease(serviceId);
    if (!lease) {
      response.status(404).json({ error: "Service not found" });
      return;
    }
  
    try {
      if (lease.runtimeKind === "container") {
        await runtimeBroker.stopService(serviceId);
      }
      store.removeServiceLease(serviceId);
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  
  app.post("/api/services/pin", (request, response) => {
    const serviceId = typeof request.body?.serviceId === "string" ? request.body.serviceId : "";
    const pinned = Boolean(request.body?.pinned);
    if (!serviceId) {
      response.status(400).json({ error: "serviceId is required" });
      return;
    }
  
    const lease = store.setServiceLeasePinned(serviceId, pinned);
    if (!lease) {
      response.status(404).json({ error: "Service not found" });
      return;
    }
  
    response.json({ ok: true, service: lease });
  });
}
