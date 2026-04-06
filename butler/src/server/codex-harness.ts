import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ButlerStateStore } from "./state-store.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, toServiceLeaseView } from "./service-templates.js";

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

  private getServiceTemplate(templateId: string): LoadedServiceTemplate {
    const template = this.serviceTemplateMap.get(templateId);
    if (!template) {
      throw new Error(`Unknown service template: ${templateId}`);
    }
    return template;
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
          template,
          containerName: service.containerName,
          targetHost: service.targetHost,
          targetPort: service.targetPort,
          worktreePath: service.worktreePath,
          status: service.status,
          createdAt: service.createdAt,
          updatedAt: service.updatedAt,
          lastError: service.lastError,
          env: service.env
        })
      );
    }

    return this.store.listServiceLeases().filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
  }

  private describeCapability(capability: HarnessCapability): string {
    const thread = this.getThreadContext(capability);
    const previews = this.store.listPreviewLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const services = this.store.listServiceLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");

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
      `Project: ${thread.supervisor.projectLabel}`,
      `Summary: ${thread.supervisor.summary}`,
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

    if (action === "context") {
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      const services = await this.reconcileThreadServices(capability.threadId);
      return {
        text: [
          `Job ${thread.id}`,
          `Workspace: ${capability.cwd}`,
          `Project: ${thread.supervisor.projectLabel}`,
          `Summary: ${thread.supervisor.summary}`,
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
          previews,
          services,
          serviceTemplates: this.serviceTemplates
        }
      };
    }

    if (action === "preview.list") {
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      return {
        text:
          previews.length === 0
            ? "No previews are attached to this job."
            : previews
                .map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.operatorUrl}`)
                .join("\n"),
        data: { previews }
      };
    }

    if (action === "preview.start") {
      const title = normalizeString(params.title) || `${thread.supervisor.projectLabel} preview`;
      const cwd = normalizeString(params.cwd) || capability.cwd;
      const command = normalizeString(params.command);
      const port = typeof params.port === "number" ? params.port : Number(params.port ?? 0);
      const image = normalizeString(params.image) || undefined;
      const egressProfile = normalizeString(params.egressProfile) || "none";
      const egressDomains = normalizeStringArray(params.egressDomains);

      if (!command || !Number.isFinite(port) || port <= 0) {
        throw new Error("preview.start requires command and port");
      }

      const lease = await this.runtimeBroker.createLease({
        leaseId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: thread.supervisor.projectId,
        projectLabel: thread.supervisor.projectLabel,
        title,
        worktreePath: cwd,
        branchName: null,
        targetPort: port,
        command,
        image,
        egressProfile,
        egressDomains
      });
      this.store.upsertPreviewLease(lease);
      this.store.addEvent(capability.threadId, "harness/preview/start", `Started preview ${lease.id}`);
      return {
        text: `Started preview ${lease.title} at ${lease.operatorUrl}.`,
        data: { lease }
      };
    }

    if (action === "preview.inspect") {
      const leaseId = normalizeString(params.leaseId);
      this.requireThreadPreview(capability, leaseId);
      const lease = await this.runtimeBroker.inspectLease(leaseId);
      this.store.upsertPreviewLease(lease);
      this.store.notePreviewLeaseActivity(leaseId);
      return {
        text: `${lease.title} is ${lease.runtime.status}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}.`,
        data: { lease }
      };
    }

    if (action === "preview.processes") {
      const leaseId = normalizeString(params.leaseId);
      this.requireThreadPreviewReady(capability, leaseId);
      const result = await this.runtimeBroker.listProcesses(leaseId);
      this.store.notePreviewLeaseActivity(leaseId);
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
      const leaseId = normalizeString(params.leaseId);
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      this.requireThreadPreviewReady(capability, leaseId);
      const result = await this.runtimeBroker.readLogs(leaseId, Number.isFinite(tail) ? tail : 200);
      this.store.notePreviewLeaseActivity(leaseId);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "preview.exec") {
      const leaseId = normalizeString(params.leaseId);
      const command = normalizeString(params.command);
      const cwd = normalizeString(params.cwd) || undefined;
      this.requireThreadPreviewReady(capability, leaseId);
      if (!command) {
        throw new Error("preview.exec requires command");
      }

      const result = await this.runtimeBroker.execInLease({ leaseId, command, cwd });
      this.store.notePreviewLeaseActivity(leaseId);
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
      const leaseId = normalizeString(params.leaseId);
      this.requireThreadPreviewReady(capability, leaseId);
      this.store.notePreviewLeaseActivity(leaseId);
      const result = await this.runtimeBroker.verifyLease({ leaseId });
      return {
        text: result.ok ? `Preview verified: ${result.title || result.url}` : `Preview verification failed${result.status ? ` (${result.status})` : ""}.`,
        data: { verification: result }
      };
    }

    if (action === "preview.stop") {
      const leaseId = normalizeString(params.leaseId);
      this.requireThreadPreview(capability, leaseId);
      this.store.markPreviewLeaseStopping(leaseId);
      await this.runtimeBroker.stopLease(leaseId);
      this.store.removePreviewLease(leaseId);
      this.store.addEvent(capability.threadId, "harness/preview/stop", `Stopped preview ${leaseId}`);
      return {
        text: `Stopped preview ${leaseId}.`,
        data: { leaseId }
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
                    `${index + 1}. ${service.id} | ${service.title} | ${service.status} | ${service.connection.uri ?? `${service.connection.host}:${service.connection.port}`}`
                )
                .join("\n"),
        data: { services }
      };
    }

    if (action === "service.start") {
      const templateId = normalizeString(params.templateId);
      const title = normalizeString(params.title);
      const cwd = normalizeString(params.cwd) || capability.cwd;
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
          projectId: thread.supervisor.projectId,
          projectLabel: thread.supervisor.projectLabel,
          title: effectiveTitle,
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
        projectId: thread.supervisor.projectId,
        projectLabel: thread.supervisor.projectLabel,
        title: effectiveTitle,
        templateId: template.id,
        templateLabel: template.label,
        runtimeKind: template.runtimeKind,
        worktreePath: cwd,
        targetPort: template.defaultPort,
        image: template.image,
        command: template.command,
        env: { ...template.envDefaults, ...env }
      });
      const lease = toServiceLeaseView({
        id: service.id,
        threadId: service.threadId,
        projectId: service.projectId,
        projectLabel: service.projectLabel,
        title: service.title,
        template,
        containerName: service.containerName,
        targetHost: service.targetHost,
        targetPort: service.targetPort,
        worktreePath: service.worktreePath,
        status: service.status,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        lastError: service.lastError,
        env: service.env
      });
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(lease.id);
      this.store.addEvent(capability.threadId, "harness/service/start", `Started service ${lease.id}`);
      return {
        text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.`,
        data: { service: lease }
      };
    }

    if (action === "service.inspect") {
      const serviceId = normalizeString(params.serviceId);
      const existing = this.requireThreadService(capability, serviceId);
      if (existing.runtimeKind === "embedded") {
        this.store.noteServiceLeaseActivity(serviceId);
        return {
          text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.`,
          data: { service: existing }
        };
      }
      const inspected = await this.runtimeBroker.inspectService(serviceId);
      const template = this.getServiceTemplate(inspected.templateId);
      const lease = toServiceLeaseView({
        id: inspected.id,
        threadId: inspected.threadId,
        projectId: inspected.projectId,
        projectLabel: inspected.projectLabel,
        title: inspected.title,
        template,
        containerName: inspected.containerName,
        targetHost: inspected.targetHost,
        targetPort: inspected.targetPort,
        worktreePath: inspected.worktreePath,
        status: inspected.status,
        createdAt: inspected.createdAt,
        updatedAt: inspected.updatedAt,
        lastError: inspected.lastError,
        env: inspected.env
      });
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(serviceId);
      return {
        text: `${lease.title} is ${inspected.runtime.status}. Host=${lease.connection.host} Port=${lease.connection.port}.`,
        data: { service: lease, runtime: inspected.runtime }
      };
    }

    if (action === "service.logs") {
      const serviceId = normalizeString(params.serviceId);
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      const service = this.requireThreadService(capability, serviceId);
      if (service.runtimeKind !== "container") {
        this.store.noteServiceLeaseActivity(serviceId);
        return {
          text: `${service.title} is embedded and does not expose container logs.`,
          data: { service }
        };
      }
      const result = await this.runtimeBroker.readServiceLogs(serviceId, Number.isFinite(tail) ? tail : 200);
      this.store.noteServiceLeaseActivity(serviceId);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "service.exec") {
      const serviceId = normalizeString(params.serviceId);
      const command = normalizeString(params.command);
      const cwd = normalizeString(params.cwd) || undefined;
      const service = this.requireThreadService(capability, serviceId);
      if (service.runtimeKind !== "container") {
        throw new Error(`${service.title} is embedded and does not support container exec`);
      }
      if (!command) {
        throw new Error("service.exec requires command");
      }
      const result = await this.runtimeBroker.execInService({ serviceId, command, cwd });
      this.store.noteServiceLeaseActivity(serviceId);
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
      const serviceId = normalizeString(params.serviceId);
      const service = this.requireThreadService(capability, serviceId);
      if (service.runtimeKind === "container") {
        await this.runtimeBroker.stopService(serviceId);
      }
      this.store.removeServiceLease(serviceId);
      this.store.addEvent(capability.threadId, "harness/service/stop", `Stopped service ${serviceId}`);
      return {
        text: `Stopped ${service.title}.`,
        data: { serviceId }
      };
    }

    throw new Error(`Unknown Codex harness action: ${action}`);
  }
}
