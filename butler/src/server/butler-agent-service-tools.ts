import crypto from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import { applyServiceStartedPolicies } from "./project-artifacts-policies.js";
import { assertRuntimeResourceOwned, getRuntimeStartThreadId, isRuntimeResourceOwned } from "./butler-runtime-tool-ownership.js";
import { toServiceLeaseView } from "./service-templates.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { stringEnumSchema, stringMapSchema } from "./butler-agent-tool-schemas.js";

const DEFAULT_SERVICE_WORKSPACE_ROOTS = ["/repos"];

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function serviceWorkspaceRoots(raw = process.env.MANOR_BUTLER_SERVICE_WORKSPACE_ROOTS): string[] {
  const configured = (raw ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return (configured.length > 0 ? configured : DEFAULT_SERVICE_WORKSPACE_ROOTS).map((entry) => path.resolve(entry));
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (!isInsideRoot(candidate, root)) throw new Error(`Path ${candidate} is outside workspace ${root}.`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Embedded service path cannot traverse symlink ${current}.`);
  }
}

export async function resolveEmbeddedServiceFilePath(worktreePath: string, fileName: string): Promise<string> {
  const requestedWorkspace = path.resolve(worktreePath);
  const roots = await Promise.all(serviceWorkspaceRoots().map(async (root) => ({ root, realRoot: await fs.realpath(root).catch(() => root) })));
  const realWorkspace = await fs.realpath(requestedWorkspace).catch(() => {
    throw new Error(`Embedded service workspace does not exist: ${requestedWorkspace}.`);
  });
  const approved = roots.find(({ root, realRoot }) => isInsideRoot(requestedWorkspace, root) && isInsideRoot(realWorkspace, realRoot));
  if (!approved) throw new Error(`Embedded service workspace ${requestedWorkspace} is outside approved roots: ${roots.map(({ root }) => root).join(", ")}.`);
  const workspaceStats = await fs.stat(realWorkspace);
  if (!workspaceStats.isDirectory()) throw new Error(`Embedded service workspace is not a directory: ${requestedWorkspace}.`);
  await assertNoSymlinkComponents(approved.root, requestedWorkspace);

  const normalizedFileName = fileName.trim();
  if (!normalizedFileName || path.isAbsolute(normalizedFileName)) throw new Error("Embedded service fileName must be a relative path inside its workspace.");
  const segments = normalizedFileName.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) throw new Error("Embedded service fileName cannot contain path traversal segments.");
  const filePath = path.resolve(realWorkspace, normalizedFileName);
  if (filePath === realWorkspace || !isInsideRoot(filePath, realWorkspace)) throw new Error("Embedded service fileName must resolve to a file inside its workspace.");
  await assertNoSymlinkComponents(realWorkspace, filePath);
  return filePath;
}

async function provisionEmbeddedServiceFile(worktreePath: string, fileName: string): Promise<string> {
  const filePath = await resolveEmbeddedServiceFilePath(worktreePath, fileName);
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true });
  await assertNoSymlinkComponents(await fs.realpath(worktreePath), filePath);
  const parentReal = await fs.realpath(parent);
  const workspaceReal = await fs.realpath(worktreePath);
  if (!isInsideRoot(parentReal, workspaceReal)) throw new Error("Embedded service file parent resolves outside its workspace.");
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !existing.isFile()) throw new Error(`Embedded service target is not a regular file: ${filePath}.`);
  const handle = await fs.open(filePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  await handle.close();
  return filePath;
}

function isSafeEmbeddedTemplateFileName(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value.trim())) return false;
  return !value.trim().replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

export function buildButlerServiceTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  const connectionSchema = Type.Optional(Type.Object({
    databaseEnv: Type.Optional(Type.String()),
    databaseValue: Type.Optional(Type.String()),
    usernameEnv: Type.Optional(Type.String()),
    usernameValue: Type.Optional(Type.String()),
    passwordEnv: Type.Optional(Type.String()),
    passwordValue: Type.Optional(Type.String()),
    uriTemplate: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String())
  }));
  const commonTemplateProperties = {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    engine: Type.String({ minLength: 1 }),
    notes: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    workingDir: Type.Optional(Type.String()),
    envDefaults: Type.Optional(stringMapSchema()),
    stackVolumePath: Type.Optional(Type.String()),
    connection: connectionSchema
  };
  const registerServiceTemplateSchema = Type.Object({
    ...commonTemplateProperties,
    runtimeKind: stringEnumSchema(["container", "embedded"] as const),
    image: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    fileName: Type.Optional(Type.String({ minLength: 1 }))
  });
  return [
    access.defineButlerTool({
      name: "list_service_templates",
      label: "List service templates",
      description: "List the registered Manor service templates Butler can provision.",
      promptSnippet: "list_service_templates: use this before provisioning local dependencies so you reuse existing registered templates before defining a new one.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_service_templates"),
      execute: async () => {
        const serviceTemplates = access.listServiceTemplates();
        const text = serviceTemplates
          .map(
            (template, index) =>
              `${index + 1}. ${template.id} | ${template.label} | runtime=${template.runtimeKind} | engine=${template.engine} | port=${template.defaultPort} | ${template.description}`
          )
          .join("\n");
        return {
          content: [{ type: "text", text: text || "No service templates are available." }],
          details: { serviceTemplates }
        };
      }
    }),
    access.defineButlerTool({
      name: "register_service_template",
      label: "Register service template",
      description: "Persist one reusable dependency service template for future jobs.",
      promptSnippet:
        "register_service_template: use this when a required dependency is missing from the current template list so Butler can define it once and reuse it later.",
      parameters: registerServiceTemplateSchema,
      uiEffects: access.getToolUiEffects("register_service_template"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          id: string;
          label: string;
          description: string;
          runtimeKind: "container" | "embedded";
          engine: string;
          image?: string;
          port?: number;
          notes?: string;
          command?: string;
          workingDir?: string;
          envDefaults?: Record<string, string>;
          fileName?: string;
          stackVolumePath?: string;
          connection?: {
            databaseEnv?: string;
            databaseValue?: string;
            usernameEnv?: string;
            usernameValue?: string;
            passwordEnv?: string;
            passwordValue?: string;
            uriTemplate?: string;
            notes?: string;
          };
        };
        if (typedParams.runtimeKind !== "container" && typedParams.runtimeKind !== "embedded") {
          throw new Error("Service template runtimeKind must be container or embedded.");
        }
        if (typedParams.runtimeKind === "container") {
          if (!typedParams.image?.trim()) throw new Error("Container service template image is required.");
          if (!Number.isInteger(typedParams.port) || (typedParams.port ?? 0) < 1 || (typedParams.port ?? 0) > 65535) {
            throw new Error("Container service template port must be an integer from 1 to 65535.");
          }
        } else {
          if (typedParams.port !== undefined && typedParams.port !== 0) throw new Error("Embedded service template port must be 0 when provided.");
          if (!isSafeEmbeddedTemplateFileName(typedParams.fileName)) throw new Error("Embedded service template fileName must be a safe relative path.");
        }
        const template = await access.serviceTemplateRegistry.upsert({
          id: typedParams.id,
          label: typedParams.label,
          description: typedParams.description,
          runtimeKind: typedParams.runtimeKind,
          engine: typedParams.engine,
          image: typedParams.image,
          port: typedParams.port,
          notes: typedParams.notes,
          command: typedParams.command,
          workingDir: typedParams.workingDir,
          envDefaults: access.normalizeServiceEnv(typedParams.envDefaults),
          fileName: typedParams.fileName,
          stackVolumePath: typedParams.stackVolumePath,
          connection: typedParams.connection
        });
        return {
          content: [
            {
              type: "text",
              text: `Registered ${template.id}. Future jobs can reuse ${template.label} without redefining it.`
            }
          ],
          details: { serviceTemplate: template }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_service",
      label: "Start service",
      description: "Provision a registered dependency service for one job, with stack-backed persistence when the stack retains volumes.",
      promptSnippet:
        "start_service: use this when an app needs a local dependency. Reuse a registered template first, and register a new one only if the dependency is missing.",
      parameters: Type.Object({
        templateId: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        stackId: Type.Optional(Type.String()),
        aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        env: Type.Optional(stringMapSchema())
      }),
      uiEffects: access.getToolUiEffects("start_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          templateId: string;
          title?: string;
          threadId?: string;
          cwd?: string;
          stackId?: string;
          aliases?: string[];
          env?: Record<string, string>;
        };
        const template = access.getServiceTemplate(typedParams.templateId);
        const threadId = getRuntimeStartThreadId(access, typedParams.threadId, "start_service");
        const thread = access.store.getThread(threadId) ?? null;
        const stack = access.getValidatedStack(typedParams.stackId?.trim() || null, threadId);
        if (stack) assertRuntimeResourceOwned(access, stack, `Stack ${stack.id}`);
        const mergedEnv = {
          ...template.envDefaults,
          ...access.normalizeServiceEnv(typedParams.env)
        };
        const serviceId = crypto.randomUUID();
        const effectiveTitle = typedParams.title?.trim() || `${template.label} ${serviceId.slice(0, 8)}`;
        const worktreePath = typedParams.cwd?.trim() || stack?.worktreePath || thread?.cwd || "/repos";
        const project = access.resolveWorkspaceProject(
          worktreePath,
          thread?.supervisor.projectId ?? "service",
          thread?.supervisor.projectLabel ?? "service"
        );

        if (template.runtimeKind === "embedded") {
          const filePath = await provisionEmbeddedServiceFile(worktreePath, template.fileName ?? ".manor/sqlite/app.db");
          const lease = toServiceLeaseView({
            id: serviceId,
            threadId,
            projectId: project.id,
            projectLabel: project.label,
            title: effectiveTitle,
            stackId: stack?.id ?? null,
            aliases: access.normalizeStringArray(typedParams.aliases),
            template,
            containerName: `embedded-${serviceId}`,
            targetHost: "local-file",
            targetPort: 0,
            worktreePath: filePath,
            status: "running",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastError: null,
            env: mergedEnv
          });
          access.store.upsertServiceLease(lease);
          const policyApplications = await applyServiceStartedPolicies({
            artifactsDir: "/artifacts",
            store: access.store,
            runtimeBroker: access.runtimeBroker,
            service: lease,
            stack
          });
          return {
            content: [{ type: "text", text: `Provisioned ${template.label}. ${lease.connection.uri ?? filePath}${policyApplications.length > 0 ? ` Surfaced ${policyApplications.length} project policy hint${policyApplications.length === 1 ? "" : "s"}.` : ""}` }],
            details: { service: lease, policyApplications }
          };
        }

        const service = await access.runtimeBroker.createService({
          serviceId,
          threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: effectiveTitle,
          stackId: stack?.id ?? null,
          aliases: access.normalizeStringArray(typedParams.aliases),
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
        access.store.upsertServiceLease(lease);
        access.store.noteServiceLeaseActivity(lease.id);
        const policyApplications = await applyServiceStartedPolicies({
          artifactsDir: "/artifacts",
          store: access.store,
          runtimeBroker: access.runtimeBroker,
          service: lease,
          stack
        });
        return {
          content: [
            {
              type: "text",
              text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.${lease.sticky ? ` Sticky volume=${lease.volumeName}.` : ""}${policyApplications.length > 0 ? ` Surfaced ${policyApplications.length} project policy hint${policyApplications.length === 1 ? "" : "s"}.` : ""}`
            }
          ],
          details: { service: lease, policyApplications }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_services",
      label: "List services",
      description: "List active disposable services and their connection details.",
      promptSnippet: "list_services: inspect local dependencies already provisioned for the current work.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_services"),
      execute: async () => {
        const syncError = await access.refreshRuntimeInventoryIfAvailable();
        const services = access.store.listServiceLeases().filter((service) => isRuntimeResourceOwned(access, service));
        const summary =
          services.length === 0
            ? "No disposable services are active."
            : services
                .map(
                  (service, index) =>
                    `${index + 1}. ${service.title} | id=${service.id} | template=${service.templateId} | status=${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | host=${service.connection.host} | port=${service.connection.port} | uri=${service.connection.uri ?? "(none)"}`
                )
                .join("\n");
        const text = syncError ? `Live runtime sync failed; showing cached state. ${syncError}\n${summary}` : summary;
        return {
          content: [{ type: "text", text }],
          details: { services, syncError }
        };
      }
    }),
    access.defineButlerTool({
      name: "inspect_service",
      label: "Inspect service",
      description: "Inspect one service runtime and return its current state.",
      promptSnippet: "inspect_service: use this before debugging a dependency so you know whether it is running and how to reach it.",
      parameters: Type.Object({
        serviceId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("inspect_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string };
        const existing = access.requireValidatedService(typedParams.serviceId, null);
        assertRuntimeResourceOwned(access, existing, `Service ${existing.id}`);
        if (existing.runtimeKind === "embedded") {
          access.store.noteServiceLeaseActivity(existing.id);
          return {
            content: [{ type: "text", text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.` }],
            details: { service: existing }
          };
        }
        const inspected = await access.runtimeBroker.inspectService(existing.id);
        assertRuntimeResourceOwned(access, inspected, `Service ${inspected.id}`);
        const template = access.getServiceTemplate(inspected.templateId);
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
        access.store.upsertServiceLease(lease);
        access.store.noteServiceLeaseActivity(lease.id);
        return {
          content: [
            {
              type: "text",
              text: `${lease.title} is ${inspected.runtime.status}. Host=${lease.connection.host} Port=${lease.connection.port}. Storage=${lease.storageKind}${lease.volumeName ? `(${lease.volumeName})` : ""}.`
            }
          ],
          details: { service: lease, runtime: inspected.runtime }
        };
      }
    }),
    access.defineButlerTool({
      name: "service_logs",
      label: "Service logs",
      description: "Read recent logs from one container-backed service runtime.",
      promptSnippet: "service_logs: use this when a dependency boot or health check is failing and you need recent container output.",
      parameters: Type.Object({
        serviceId: Type.String({ minLength: 1 }),
        tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
      }),
      uiEffects: access.getToolUiEffects("service_logs"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string; tail?: number };
        const service = access.requireValidatedService(typedParams.serviceId, null);
        assertRuntimeResourceOwned(access, service, `Service ${service.id}`);
        if (service.runtimeKind !== "container") {
          access.store.noteServiceLeaseActivity(service.id);
          return {
            content: [{ type: "text", text: `${service.title} is embedded and does not expose container logs.` }],
            details: { service }
          };
        }
        const result = await access.runtimeBroker.readServiceLogs(service.id, typedParams.tail ?? 200);
        access.store.noteServiceLeaseActivity(service.id);
        return {
          content: [{ type: "text", text: result.logs || "No logs were returned." }],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "exec_service",
      label: "Exec in service",
      description: "Run one shell command inside a container-backed dependency service.",
      promptSnippet: "exec_service: use this when Butler needs to inspect or patch one dependency service directly.",
      parameters: Type.Object({
        serviceId: Type.String({ minLength: 1 }),
        command: Type.String({ minLength: 1 }),
        cwd: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("exec_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string; command: string; cwd?: string };
        const service = access.requireValidatedService(typedParams.serviceId, null);
        assertRuntimeResourceOwned(access, service, `Service ${service.id}`);
        if (service.runtimeKind !== "container") {
          throw new Error(`${service.title} is embedded and does not support container exec`);
        }
        const result = await access.runtimeBroker.execInService({
          serviceId: service.id,
          command: typedParams.command,
          cwd: typedParams.cwd
        });
        access.store.noteServiceLeaseActivity(service.id);
        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        const body =
          [`exit=${result.exitCode ?? "unknown"}`]
            .concat(stdout ? [`stdout:\n${stdout}`] : [])
            .concat(stderr ? [`stderr:\n${stderr}`] : [])
            .join("\n\n") || `exit=${result.exitCode ?? "unknown"}`;
        return {
          content: [{ type: "text", text: body }],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_service",
      label: "Stop service",
      description: "Stop one disposable dependency service and release its lease.",
      promptSnippet: "stop_service: use this when a disposable dependency is no longer needed for the job.",
      parameters: Type.Object({
        serviceId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("stop_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string };
        const service = access.requireValidatedService(typedParams.serviceId, null);
        assertRuntimeResourceOwned(access, service, `Service ${service.id}`);
        if (service.runtimeKind === "container") {
          await access.runtimeBroker.stopService(service.id);
        }
        access.store.removeServiceLease(service.id);
        return {
          content: [{ type: "text", text: `Stopped ${service.title}.` }],
          details: { serviceId: service.id }
        };
      }
    })
  ];
}
