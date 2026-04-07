import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { decoratePreviewVerification } from "./preview-verification.js";
import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { ButlerStateStore } from "./state-store.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";

type HarnessCapability = {
  id: string;
  token: string;
  threadId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
};

type HarnessRegistryPayload = {
  capabilities: HarnessCapability[];
};

type BrokerAccessRegistryPayload = {
  grants: Array<{
    token: string;
    threadId: string;
    createdAt: number;
    updatedAt: number;
  }>;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => normalizeString(entry)).filter(Boolean))];
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
      .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
  );
}

function normalizePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.trunc(numeric));
}

function normalizeHeartbeatKind(value: unknown): "none" | "http" | "tcp" | "command" | null {
  const normalized = normalizeString(value);
  if (normalized === "none" || normalized === "http" || normalized === "tcp" || normalized === "command") {
    return normalized;
  }
  return null;
}

export class CodexHarnessService {
  private readonly registryPath: string;
  private readonly brokerAccessPath: string;
  private readonly store: ButlerStateStore;
  private readonly runtimeBroker: RuntimeBrokerClient;
  private readonly serviceTemplates: LoadedServiceTemplate[];
  private readonly serviceTemplateMap: Map<string, LoadedServiceTemplate>;
  private readonly capabilities = new Map<string, HarnessCapability>();

  constructor(options: {
    codexHomeDir: string;
    stateDir: string;
    store: ButlerStateStore;
    runtimeBroker: RuntimeBrokerClient;
    serviceTemplates: LoadedServiceTemplate[];
  }) {
    this.registryPath = path.join(options.codexHomeDir, "manor", "harness-capabilities.json");
    this.brokerAccessPath = path.join(options.stateDir, "codex-broker-access.json");
    this.store = options.store;
    this.runtimeBroker = options.runtimeBroker;
    this.serviceTemplates = options.serviceTemplates;
    this.serviceTemplateMap = new Map(this.serviceTemplates.map((template) => [template.id, template]));
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.mkdir(path.dirname(this.brokerAccessPath), { recursive: true });
    const raw = await fs.readFile(this.registryPath, "utf8").catch(() => "");
    if (!raw) {
      await this.save();
      return;
    }

    const parsed = JSON.parse(raw) as Partial<HarnessRegistryPayload>;
    const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : [];
    this.capabilities.clear();
    for (const entry of capabilities) {
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.token === "string" &&
        typeof entry.threadId === "string" &&
        typeof entry.cwd === "string"
      ) {
        this.capabilities.set(entry.threadId, {
          id: entry.id,
          token: entry.token,
          threadId: entry.threadId,
          cwd: entry.cwd,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now()
        });
      }
    }
  }

  private async save(): Promise<void> {
    const payload: HarnessRegistryPayload = {
      capabilities: [...this.capabilities.values()].sort((left, right) => left.createdAt - right.createdAt)
    };
    const brokerAccessPayload: BrokerAccessRegistryPayload = {
      grants: payload.capabilities.map((capability) => ({
        token: capability.token,
        threadId: capability.threadId,
        createdAt: capability.createdAt,
        updatedAt: capability.updatedAt
      }))
    };
    await fs.writeFile(this.registryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.writeFile(this.brokerAccessPath, `${JSON.stringify(brokerAccessPayload, null, 2)}\n`, "utf8");
  }

  async ensureThreadCapability(threadId: string, cwd: string | null | undefined): Promise<HarnessCapability | null> {
    const normalizedCwd = normalizeString(cwd);
    if (!threadId || !normalizedCwd || normalizedCwd === "/repos") {
      return null;
    }

    const now = Date.now();
    const existing = this.capabilities.get(threadId);
    const nextCapability: HarnessCapability = existing
      ? {
          ...existing,
          cwd: normalizedCwd,
          updatedAt: now
        }
      : {
          id: crypto.randomUUID(),
          token: crypto.randomBytes(24).toString("hex"),
          threadId,
          cwd: normalizedCwd,
          createdAt: now,
          updatedAt: now
        };

    this.capabilities.set(threadId, nextCapability);
    await this.save();
    await this.maybeAdoptWorkspaceStack(nextCapability).catch(() => null);
    return nextCapability;
  }

  async revokeThreadCapability(threadId: string): Promise<void> {
    if (!this.capabilities.delete(threadId)) {
      return;
    }

    await this.save();
  }

  private getCapabilityByToken(token: string): HarnessCapability | null {
    const normalized = normalizeString(token);
    if (!normalized) {
      return null;
    }

    for (const capability of this.capabilities.values()) {
      if (capability.token === normalized) {
        return capability;
      }
    }

    return null;
  }

  private requireCapability(token: string): HarnessCapability {
    const capability = this.getCapabilityByToken(token);
    if (!capability) {
      throw new Error("Invalid Codex harness token");
    }

    const thread = this.store.getThread(capability.threadId);
    if (!thread) {
      throw new Error("Codex harness capability references an unknown thread");
    }

    return capability;
  }

  private getThreadContext(capability: HarnessCapability) {
    const thread = this.store.getThread(capability.threadId);
    if (!thread) {
      throw new Error("Codex thread is no longer available");
    }

    return thread;
  }

  private requireThreadPreview(capability: HarnessCapability, leaseId: string) {
    const lease = this.store.getPreviewLease(leaseId);
    if (!lease || lease.threadId !== capability.threadId) {
      throw new Error(`Preview ${leaseId} is not attached to this job`);
    }
    return lease;
  }

  private requireThreadPreviewReady(capability: HarnessCapability, leaseId: string) {
    const lease = this.requireThreadPreview(capability, leaseId);
    if (lease.status === "stopping") {
      throw new Error(`Preview ${leaseId} is stopping. Retry in a moment.`);
    }
    if (lease.status === "starting") {
      throw new Error(`Preview ${leaseId} is still starting. Retry in a moment.`);
    }
    return lease;
  }

  private requireThreadService(capability: HarnessCapability, serviceId: string) {
    const lease = this.store.getServiceLease(serviceId);
    if (!lease || lease.threadId !== capability.threadId) {
      throw new Error(`Service ${serviceId} is not attached to this job`);
    }
    return lease;
  }

  private matchThreadPreview(threadId: string, selector: string) {
    const normalizedSelector = normalizeString(selector);
    if (!normalizedSelector) {
      return null;
    }

    const threadPreviews = this.store
      .listPreviewLeases()
      .filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
    const directIdMatch = threadPreviews.find((lease) => lease.id === normalizedSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadPreviews.filter((lease) => lease.title === normalizedSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadPreviews.filter((lease) => lease.aliases.includes(normalizedSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const foldedSelector = normalizedSelector.toLowerCase();
    const foldedTitleMatches = threadPreviews.filter((lease) => lease.title.trim().toLowerCase() === foldedSelector);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadPreviews.filter((lease) =>
      lease.aliases.some((alias) => alias.trim().toLowerCase() === foldedSelector)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    return null;
  }

  private matchThreadService(threadId: string, selector: string) {
    const normalizedSelector = normalizeString(selector);
    if (!normalizedSelector) {
      return null;
    }

    const threadServices = this.store
      .listServiceLeases()
      .filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
    const directIdMatch = threadServices.find((lease) => lease.id === normalizedSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadServices.filter((lease) => lease.title === normalizedSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadServices.filter((lease) => lease.aliases.includes(normalizedSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const foldedSelector = normalizedSelector.toLowerCase();
    const foldedTitleMatches = threadServices.filter((lease) => lease.title.trim().toLowerCase() === foldedSelector);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadServices.filter((lease) =>
      lease.aliases.some((alias) => alias.trim().toLowerCase() === foldedSelector)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    return null;
  }

  private matchThreadStack(threadId: string, selector: string) {
    const normalizedSelector = normalizeString(selector);
    if (!normalizedSelector) {
      return null;
    }

    const threadStacks = this.store
      .listStackLeases()
      .filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
    const directIdMatch = threadStacks.find((lease) => lease.id === normalizedSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadStacks.filter((lease) => lease.title === normalizedSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const foldedSelector = normalizedSelector.toLowerCase();
    const foldedTitleMatches = threadStacks.filter((lease) => lease.title.trim().toLowerCase() === foldedSelector);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    return null;
  }

  private resolveWorkspaceProject(
    cwd: string | null | undefined,
    thread: ReturnType<CodexHarnessService["getThreadContext"]>
  ) {
    const project = resolveWorkspaceProjectInfo(cwd || thread.cwd);
    if (project.id === "unknown") {
      return {
        id: thread.supervisor.projectId,
        label: thread.supervisor.projectLabel
      };
    }

    return project;
  }

  private async resolveThreadStack(capability: HarnessCapability, stackSelector: string) {
    const storedMatch = this.matchThreadStack(capability.threadId, stackSelector);
    if (storedMatch) {
      return storedMatch;
    }

    await this.reconcileThreadStacks(capability.threadId);
    const refreshedMatch = this.matchThreadStack(capability.threadId, stackSelector);
    if (refreshedMatch) {
      return refreshedMatch;
    }

    throw new Error(`Stack ${stackSelector} is not attached to this job`);
  }

  private async resolveThreadPreview(capability: HarnessCapability, previewSelector: string) {
    const storedMatch = this.matchThreadPreview(capability.threadId, previewSelector);
    if (storedMatch) {
      return storedMatch;
    }

    await this.reconcileThreadPreviews(capability.threadId);
    const refreshedMatch = this.matchThreadPreview(capability.threadId, previewSelector);
    if (refreshedMatch) {
      return refreshedMatch;
    }

    throw new Error(`Preview ${previewSelector} is not attached to this job`);
  }

  private async resolveThreadService(capability: HarnessCapability, serviceSelector: string) {
    const storedMatch = this.matchThreadService(capability.threadId, serviceSelector);
    if (storedMatch) {
      return storedMatch;
    }

    await this.reconcileThreadServices(capability.threadId);
    const refreshedMatch = this.matchThreadService(capability.threadId, serviceSelector);
    if (refreshedMatch) {
      return refreshedMatch;
    }

    throw new Error(`Service ${serviceSelector} is not attached to this job`);
  }

  private async maybeAdoptWorkspaceStack(capability: HarnessCapability) {
    const attachedStacks = await this.runtimeBroker.listStacks(capability.threadId);
    for (const stack of attachedStacks) {
      this.store.upsertStackLease(stack);
    }
    if (attachedStacks.length > 0) {
      return null;
    }

    const candidates = (await this.runtimeBroker.listStacks()).filter(
      (stack) => !stack.threadId && normalizeString(stack.worktreePath) === capability.cwd
    );
    if (candidates.length !== 1) {
      return null;
    }

    const adopted = await this.runtimeBroker.adoptStack({
      stackId: candidates[0].id,
      threadId: capability.threadId
    });
    this.store.upsertStackLease(adopted);
    this.store.addEvent(capability.threadId, "harness/stack/adopt", `Adopted stack ${adopted.id}`);
    return adopted;
  }

  private getServiceTemplate(templateId: string): LoadedServiceTemplate {
    const template = this.serviceTemplateMap.get(templateId);
    if (!template) {
      throw new Error(`Unknown service template: ${templateId}`);
    }
    return template;
  }

  private removeStackArtifacts(stackId: string) {
    for (const lease of this.store.listPreviewLeases()) {
      if (lease.stackId === stackId) {
        this.store.removePreviewLease(lease.id);
      }
    }
    for (const lease of this.store.listServiceLeases()) {
      if (lease.stackId === stackId) {
        this.store.removeServiceLease(lease.id);
      }
    }
    this.store.removeStackLease(stackId);
  }

  private async reconcileThreadPreviews(threadId: string) {
    const brokerLeases = await this.runtimeBroker.listLeases(threadId);
    const brokerLeaseMap = new Map(brokerLeases.map((lease) => [lease.id, lease]));
    const storedLeases = this.store.listPreviewLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");

    for (const lease of storedLeases) {
      if (!brokerLeaseMap.has(lease.id)) {
        this.store.removePreviewLease(lease.id);
      }
    }

    for (const lease of brokerLeases) {
      this.store.upsertPreviewLease(lease);
    }

    return brokerLeases.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async reconcileThreadStacks(threadId: string) {
    const brokerStacks = await this.runtimeBroker.listStacks(threadId);
    const brokerStackIds = new Set(brokerStacks.map((stack) => stack.id));
    const storedStacks = this.store.listStackLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");

    for (const lease of storedStacks) {
      if (!brokerStackIds.has(lease.id)) {
        this.store.removeStackLease(lease.id);
      }
    }

    for (const stack of brokerStacks) {
      this.store.upsertStackLease(stack);
    }

    return this.store.listStackLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
  }

  private async reconcileThreadServices(threadId: string) {
    const brokerServices = await this.runtimeBroker.listServices(threadId);
    const brokerServiceIds = new Set(brokerServices.map((service) => service.id));
    const storedServices = this.store.listServiceLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");

    for (const lease of storedServices) {
      if (lease.runtimeKind === "container" && !brokerServiceIds.has(lease.id)) {
        this.store.removeServiceLease(lease.id);
      }
    }

    for (const service of brokerServices) {
      const template = this.serviceTemplateMap.get(service.templateId);
      if (!template) {
        continue;
      }

      this.store.upsertServiceLease(
        toServiceLeaseView({
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
        })
      );
    }

    return this.store.listServiceLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
  }

  private describeStackStorage(stack: {
    storageMode: "ephemeral" | "job" | "base" | "custom";
    baseStorageKey: string | null;
    storageKey: string | null;
    cloneFromStorageKey: string | null;
    defaultPromoteTargetStorageKey: string | null;
    retainsVolumes: boolean;
    volumeNames: string[];
  }) {
    return formatStackStorageSummary(stack);
  }

  private describeCapability(capability: HarnessCapability): string {
    const thread = this.getThreadContext(capability);
    const project = this.resolveWorkspaceProject(capability.cwd, thread);
    const stacks = this.store.listStackLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const previews = this.store.listPreviewLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const services = this.store.listServiceLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");

    const stackLines =
      stacks.length === 0
        ? "Stacks: none"
        : `Stacks:\n${stacks.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | network=${lease.networkName} | ${this.describeStackStorage(lease)} | previews=${lease.previewIds.length} | services=${lease.serviceIds.length}`).join("\n")}`;
    const previewLines =
      previews.length === 0
        ? "Previews: none"
        : `Previews:\n${previews.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.operatorUrl}`).join("\n")}`;
    const serviceLines =
      services.length === 0
        ? "Services: none"
        : `Services:\n${services.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.connection.uri ?? `${lease.connection.host}:${lease.connection.port}`}`).join("\n")}`;

    return [
      `Job ${thread.id}`,
      `Workspace: ${capability.cwd}`,
      `Project: ${project.label}`,
      `Summary: ${thread.supervisor.summary}`,
      stackLines,
      previewLines,
      serviceLines,
      `Service templates: ${this.serviceTemplates.map((template) => template.id).join(", ")}`
    ].join("\n");
  }

  async handleAction(input: {
    token: string;
    action: string;
    params?: Record<string, unknown>;
  }): Promise<{ text: string; data?: Record<string, unknown> }> {
    const capability = this.requireCapability(input.token);
    const action = normalizeString(input.action);
    const params = input.params ?? {};
    const thread = this.getThreadContext(capability);

    if (action === "context" || action.startsWith("stack.") || action.startsWith("preview.") || action.startsWith("service.")) {
      await this.maybeAdoptWorkspaceStack(capability);
    }

    if (action === "context") {
      const project = this.resolveWorkspaceProject(capability.cwd, thread);
      const stacks = await this.reconcileThreadStacks(capability.threadId);
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      const services = await this.reconcileThreadServices(capability.threadId);
      return {
        text: [
          `Job ${thread.id}`,
          `Workspace: ${capability.cwd}`,
          `Project: ${project.label}`,
          `Summary: ${thread.supervisor.summary}`,
          stacks.length === 0
            ? "Stacks: none"
            : `Stacks:\n${stacks.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | network=${lease.networkName} | ${this.describeStackStorage(lease)} | previews=${lease.previewIds.length} | services=${lease.serviceIds.length}`).join("\n")}`,
          previews.length === 0
            ? "Previews: none"
            : `Previews:\n${previews.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.operatorUrl}`).join("\n")}`,
          services.length === 0
            ? "Services: none"
            : `Services:\n${services.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.connection.uri ?? `${lease.connection.host}:${lease.connection.port}`}`).join("\n")}`,
          `Service templates: ${this.serviceTemplates.map((template) => template.id).join(", ")}`
        ].join("\n"),
        data: {
          threadId: thread.id,
          cwd: capability.cwd,
          stacks,
          previews,
          services,
          serviceTemplates: this.serviceTemplates
        }
      };
    }

    if (action === "report") {
      const status = normalizeString(params.status);
      const summary = normalizeString(params.summary);
      const details = normalizeString(params.details) || null;
      const turnId = normalizeString(params.turnId) || null;

      if ((status !== "completed" && status !== "blocked") || !summary) {
        throw new Error("report requires status=completed|blocked and a non-empty summary");
      }

      const report = this.store.recordWorkerReport(capability.threadId, {
        status,
        summary,
        details,
        turnId
      });
      this.store.addEvent(capability.threadId, `harness/report/${status}`, summary);
      return {
        text: `Recorded ${status} supervisor report for job ${capability.threadId}.`,
        data: { report }
      };
    }

    if (action === "preview.list") {
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      return {
        text:
          previews.length === 0
            ? "No previews are attached to this job."
            : previews
                .map(
                  (lease, index) =>
                    `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status}/${lease.bootstrap.phase} | ${lease.operatorUrl}`
                )
                .join("\n"),
        data: { previews }
      };
    }

    if (action === "stack.list") {
      const stacks = await this.reconcileThreadStacks(capability.threadId);
      return {
        text:
          stacks.length === 0
            ? "No stacks are attached to this job."
            : stacks
                .map(
                  (stack, index) =>
                    `${index + 1}. ${stack.id} | ${stack.title} | ${stack.status} | network=${stack.networkName} | ${this.describeStackStorage(stack)} | previews=${stack.previewIds.length} | services=${stack.serviceIds.length}`
                )
                .join("\n"),
        data: { stacks }
      };
    }

    if (action === "stack.start" || action === "stack.start_stateful") {
      const title = normalizeString(params.title) || `${thread.supervisor.projectLabel} stack`;
      const cwd = normalizeString(params.cwd) || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const requestedStorageMode =
        action === "stack.start_stateful"
          ? normalizeStackStorageMode(params.storageMode) || "job"
          : normalizeStackStorageMode(params.storageMode);
      const retainsVolumes = params.retainsVolumes === true;
      const storageKey = normalizeString(params.storageKey) || null;
      const cloneFromStorageKey = normalizeString(params.cloneFromStorageKey) || null;
      const stack = await this.runtimeBroker.createStack({
        stackId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        worktreePath: cwd,
        storageMode: requestedStorageMode,
        retainsVolumes,
        storageKey,
        cloneFromStorageKey
      });
      this.store.upsertStackLease(stack);
      this.store.addEvent(capability.threadId, "harness/stack/start", `Started stack ${stack.id}`);
      return {
        text: `Started stack ${stack.title}. Network=${stack.networkName}. ${this.describeStackStorage(stack)}.`,
        data: { stack }
      };
    }

    if (action === "stack.inspect") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const inspected = await this.runtimeBroker.inspectStack(stack.id);
      this.store.upsertStackLease(inspected);
      this.store.noteStackLeaseActivity(inspected.id);
      return {
        text: `${inspected.title} is ${inspected.status}. Network=${inspected.networkName}. ${this.describeStackStorage(inspected)}. Previews=${inspected.previewIds.length}. Services=${inspected.serviceIds.length}.`,
        data: { stack: inspected }
      };
    }

    if (action === "stack.promote") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const targetStorageKey = normalizeString(params.targetStorageKey) || null;
      const promotion = await this.runtimeBroker.promoteStack({
        stackId: stack.id,
        targetStorageKey
      });
      const inspected = await this.runtimeBroker.inspectStack(stack.id);
      this.store.upsertStackLease(inspected);
      this.store.noteStackLeaseActivity(inspected.id);
      this.store.addEvent(
        capability.threadId,
        "harness/stack/promote",
        `Promoted stack ${inspected.id} to ${promotion.targetStorageKey}`
      );
      return {
        text: `Promoted ${promotion.promotedVolumes.length} volumes from ${promotion.sourceStorageKey} to ${promotion.targetStorageKey}.`,
        data: { promotion, stack: inspected }
      };
    }

    if (action === "stack.stop") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const dropVolumes = params.dropVolumes === true;
      await this.runtimeBroker.stopStack(stack.id, { dropVolumes });
      this.removeStackArtifacts(stack.id);
      this.store.addEvent(capability.threadId, "harness/stack/stop", `Stopped stack ${stack.id}`);
      return {
        text: `Stopped stack ${stack.id}.${dropVolumes ? " Dropped retained volumes." : ""}`,
        data: { stackId: stack.id, dropVolumes }
      };
    }

    if (action === "preview.start") {
      const title = normalizeString(params.title) || `${thread.supervisor.projectLabel} preview`;
      const command = normalizeString(params.command);
      const stackSelector = normalizeString(params.stackId) || null;
      const stack = stackSelector ? await this.resolveThreadStack(capability, stackSelector) : null;
      const cwd = normalizeString(params.cwd) || stack?.worktreePath || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const aliases = normalizeStringArray(params.aliases);
      const env = normalizeEnv(params.env);
      const port = typeof params.port === "number" ? params.port : Number(params.port ?? 0);
      const image = normalizeString(params.image) || undefined;
      const egressProfile = normalizeString(params.egressProfile) || "none";
      const egressDomains = normalizeStringArray(params.egressDomains);
      const bootstrapWaitSeconds = normalizePositiveInteger(params.bootstrapWaitSeconds) ?? undefined;
      const bootstrapHint = normalizeString(params.bootstrapHint) || undefined;
      const heartbeatKind = normalizeHeartbeatKind(params.heartbeatKind) ?? undefined;
      const heartbeatTarget = normalizeString(params.heartbeatTarget) || undefined;
      const heartbeatIntervalSeconds = normalizePositiveInteger(params.heartbeatIntervalSeconds) ?? undefined;

      if (!command || !Number.isFinite(port) || port <= 0) {
        throw new Error("preview.start requires command and port");
      }

      const lease = await this.runtimeBroker.createLease({
        leaseId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        stackId: stack?.id ?? null,
        aliases,
        worktreePath: cwd,
        branchName: null,
        targetPort: port,
        command,
        image,
        egressProfile,
        egressDomains,
        bootstrapWaitSeconds,
        bootstrapHint,
        heartbeatKind,
        heartbeatTarget,
        heartbeatIntervalSeconds,
        env
      });
      this.store.upsertPreviewLease(lease);
      this.store.addEvent(capability.threadId, "harness/preview/start", `Started preview ${lease.id}`);
      return {
        text: `Started preview ${lease.title} at ${lease.operatorUrl}.`,
        data: { lease }
      };
    }

    if (action === "preview.inspect") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const lease = await this.runtimeBroker.inspectLease(preview.id);
      this.store.upsertPreviewLease(lease);
      this.store.notePreviewLeaseActivity(lease.id);
      return {
        text: `${lease.title} is ${lease.runtime.status}. Bootstrap=${lease.bootstrap.phase}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}.`,
        data: { lease }
      };
    }

    if (action === "preview.processes") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      this.requireThreadPreviewReady(capability, preview.id);
      const result = await this.runtimeBroker.listProcesses(preview.id);
      this.store.notePreviewLeaseActivity(preview.id);
      const rows =
        result.processes.length === 0
          ? "No processes were reported."
          : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
      return {
        text: rows,
        data: { processes: result }
      };
    }

    if (action === "preview.logs") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      this.requireThreadPreviewReady(capability, preview.id);
      const result = await this.runtimeBroker.readLogs(preview.id, Number.isFinite(tail) ? tail : 200);
      this.store.notePreviewLeaseActivity(preview.id);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "preview.exec") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const command = normalizeString(params.command);
      const cwd = normalizeString(params.cwd) || undefined;
      const stdin = typeof params.stdin === "string" ? params.stdin : undefined;
      const stdinProvided = params.stdinProvided === true;
      this.requireThreadPreviewReady(capability, preview.id);
      if (!command) {
        throw new Error("preview.exec requires command");
      }

      const result = await this.runtimeBroker.execInLease({
        leaseId: preview.id,
        command,
        cwd,
        stdin,
        stdinProvided
      });
      this.store.notePreviewLeaseActivity(preview.id);
      const body = [
        `exitCode=${result.exitCode ?? "unknown"}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        text: body || "Command completed with no output.",
        data: { result }
      };
    }

    if (action === "preview.verify") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const mode = normalizeString(params.mode) === "headful" ? "headful" : "headless";
      this.requireThreadPreviewReady(capability, preview.id);
      this.store.notePreviewLeaseActivity(preview.id);
      const result = decoratePreviewVerification(await this.runtimeBroker.verifyLease({ leaseId: preview.id, mode }));
      this.store.recordPreviewLeaseVerification(preview.id, result);
      return {
        text:
          result.ok
            ? `Preview verified (${result.mode}): ${result.title || result.url}`
            : `Preview verification failed (${result.mode})${result.status ? ` (${result.status})` : ""}.`,
        data: { verification: result }
      };
    }

    if (action === "preview.proof") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const runId = normalizeString(params.runId) || null;
      const verification = preview.lastVerification ? decoratePreviewVerification(preview.lastVerification) : null;
      if (!verification) {
        throw new Error(`Preview ${preview.id} has no verification proof yet.`);
      }
      if (runId && verification.runId !== runId) {
        throw new Error(`Preview ${preview.id} does not have verification run ${runId}.`);
      }

      const artifactLines = await Promise.all(
        verification.artifacts.map(async (artifact) => {
          const exists =
            artifact.availability === "available" && artifact.filePath
              ? await fs
                  .stat(artifact.filePath)
                  .then(() => true)
                  .catch(() => false)
              : false;
          const availability = artifact.availability === "available" && exists ? "ready" : artifact.availability;
          return `${artifact.kind} | file=${artifact.filePath || "(none)"} | url=${artifact.url ?? "(none)"} | download=${artifact.downloadUrl ?? "(none)"} | ${availability}`;
        })
      );

      this.store.notePreviewLeaseActivity(preview.id);
      return {
        text: [
          `Preview ${preview.id}`,
          `Verification run=${verification.runId} mode=${verification.mode} ok=${verification.ok} status=${verification.status ?? "none"}`,
          artifactLines.length > 0 ? `Artifacts:\n${artifactLines.join("\n")}` : "Artifacts: none"
        ].join("\n"),
        data: {
          preview,
          verification
        }
      };
    }

    if (action === "preview.stop") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      this.requireThreadPreview(capability, preview.id);
      this.store.markPreviewLeaseStopping(preview.id);
      await this.runtimeBroker.stopLease(preview.id);
      this.store.removePreviewLease(preview.id);
      this.store.addEvent(capability.threadId, "harness/preview/stop", `Stopped preview ${preview.id}`);
      return {
        text: `Stopped preview ${preview.id}.`,
        data: { leaseId: preview.id }
      };
    }

    if (action === "service.templates") {
      return {
        text: this.serviceTemplates.map((template, index) => `${index + 1}. ${template.id} | ${template.label} | ${template.description}`).join("\n"),
        data: { serviceTemplates: this.serviceTemplates }
      };
    }

    if (action === "service.list") {
      const services = await this.reconcileThreadServices(capability.threadId);
      return {
        text:
          services.length === 0
            ? "No services are attached to this job."
            : services
                .map(
                  (service, index) =>
                    `${index + 1}. ${service.id} | ${service.title} | ${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | ${service.connection.uri ?? `${service.connection.host}:${service.connection.port}`}`
                )
                .join("\n"),
        data: { services }
      };
    }

    if (action === "service.processes") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (service.runtimeKind !== "container") {
        this.store.noteServiceLeaseActivity(service.id);
        return {
          text: `${service.title} is embedded and does not expose container processes.`,
          data: { service }
        };
      }
      const result = await this.runtimeBroker.listServiceProcesses(service.id);
      this.store.noteServiceLeaseActivity(service.id);
      const rows =
        result.processes.length === 0
          ? "No processes were reported."
          : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
      return {
        text: rows,
        data: { processes: result }
      };
    }

    if (action === "service.start") {
      const templateId = normalizeString(params.templateId);
      const title = normalizeString(params.title);
      const stackSelector = normalizeString(params.stackId) || null;
      const stack = stackSelector ? await this.resolveThreadStack(capability, stackSelector) : null;
      const cwd = normalizeString(params.cwd) || stack?.worktreePath || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const aliases = normalizeStringArray(params.aliases);
      const env = normalizeEnv(params.env);
      const template = this.serviceTemplateMap.get(templateId);

      if (!template) {
        throw new Error(`Unknown service template: ${templateId}`);
      }

      const effectiveTitle = title || `${template.label} ${crypto.randomUUID().slice(0, 8)}`;

      if (template.runtimeKind === "embedded") {
        const filePath = `${cwd}/${template.fileName ?? ".manor/sqlite/app.db"}`.replace(/\/+/g, "/");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const lease = toServiceLeaseView({
          id: crypto.randomUUID(),
          threadId: capability.threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: effectiveTitle,
          stackId: stack?.id ?? null,
          aliases,
          template,
          containerName: `embedded-${crypto.randomUUID().slice(0, 8)}`,
          targetHost: "localhost",
          targetPort: template.defaultPort,
          worktreePath: filePath,
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastError: null,
          env
        });
        this.store.upsertServiceLease(lease);
        this.store.noteServiceLeaseActivity(lease.id);
        this.store.addEvent(capability.threadId, "harness/service/start", `Started service ${lease.id}`);
        return {
          text: `Prepared ${template.label} at ${lease.connection.uri ?? filePath}.`,
          data: { service: lease }
        };
      }

      const service = await this.runtimeBroker.createService({
        serviceId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title: effectiveTitle,
        stackId: stack?.id ?? null,
        aliases,
        templateId: template.id,
        templateLabel: template.label,
        runtimeKind: template.runtimeKind,
        worktreePath: cwd,
        targetPort: template.defaultPort,
        image: template.image,
        command: template.command,
        stackVolumePath: template.stackVolumePath,
        env: { ...template.envDefaults, ...env }
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
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(lease.id);
      this.store.addEvent(capability.threadId, "harness/service/start", `Started service ${lease.id}`);
      return {
        text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.${lease.sticky ? ` Sticky volume=${lease.volumeName}.` : ""}`,
        data: { service: lease }
      };
    }

    if (action === "service.inspect") {
      const existing = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (existing.runtimeKind === "embedded") {
        this.store.noteServiceLeaseActivity(existing.id);
        return {
          text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.`,
          data: { service: existing }
        };
      }
      const inspected = await this.runtimeBroker.inspectService(existing.id);
      const template = this.getServiceTemplate(inspected.templateId);
      const lease = toServiceLeaseView({
        id: inspected.id,
        threadId: inspected.threadId,
        projectId: inspected.projectId,
        projectLabel: inspected.projectLabel,
        title: inspected.title,
        stackId: inspected.stackId,
        aliases: inspected.aliases,
        template,
        containerName: inspected.containerName,
        targetHost: inspected.targetHost,
        targetPort: inspected.targetPort,
        worktreePath: inspected.worktreePath,
        status: inspected.status,
        storageKind: inspected.storageKind,
        sticky: inspected.sticky,
        volumeName: inspected.volumeName,
        volumeMountPath: inspected.volumeMountPath,
        createdAt: inspected.createdAt,
        updatedAt: inspected.updatedAt,
        lastError: inspected.lastError,
        env: inspected.env
      });
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(lease.id);
      return {
        text: `${lease.title} is ${inspected.runtime.status}. Host=${lease.connection.host} Port=${lease.connection.port}. Storage=${lease.storageKind}${lease.volumeName ? `(${lease.volumeName})` : ""}.`,
        data: { service: lease, runtime: inspected.runtime }
      };
    }

    if (action === "service.logs") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      if (service.runtimeKind !== "container") {
        this.store.noteServiceLeaseActivity(service.id);
        return {
          text: `${service.title} is embedded and does not expose container logs.`,
          data: { service }
        };
      }
      const result = await this.runtimeBroker.readServiceLogs(service.id, Number.isFinite(tail) ? tail : 200);
      this.store.noteServiceLeaseActivity(service.id);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "service.exec") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      const command = normalizeString(params.command);
      const cwd = normalizeString(params.cwd) || undefined;
      const stdin = typeof params.stdin === "string" ? params.stdin : undefined;
      const stdinProvided = params.stdinProvided === true;
      if (service.runtimeKind !== "container") {
        throw new Error(`${service.title} is embedded and does not support container exec`);
      }
      if (!command) {
        throw new Error("service.exec requires command");
      }
      const result = await this.runtimeBroker.execInService({
        serviceId: service.id,
        command,
        cwd,
        stdin,
        stdinProvided
      });
      this.store.noteServiceLeaseActivity(service.id);
      const body = [
        `exitCode=${result.exitCode ?? "unknown"}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        text: body || "Command completed with no output.",
        data: { result }
      };
    }

    if (action === "service.stop") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (service.runtimeKind === "container") {
        await this.runtimeBroker.stopService(service.id);
      }
      this.store.removeServiceLease(service.id);
      this.store.addEvent(capability.threadId, "harness/service/stop", `Stopped service ${service.id}`);
      return {
        text: `Stopped ${service.title}.`,
        data: { serviceId: service.id }
      };
    }

    throw new Error(`Unknown Codex harness action: ${action}`);
  }
}
