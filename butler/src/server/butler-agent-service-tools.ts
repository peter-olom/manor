import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import { toServiceLeaseView } from "./service-templates.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";

export function buildButlerServiceTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
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
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        runtimeKind: Type.Union([Type.Literal("container"), Type.Literal("embedded")]),
        engine: Type.String({ minLength: 1 }),
        image: Type.Optional(Type.String({ minLength: 1 })),
        port: Type.Optional(Type.Number()),
        notes: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        envDefaults: Type.Optional(Type.Record(Type.String(), Type.String())),
        fileName: Type.Optional(Type.String()),
        stackVolumePath: Type.Optional(Type.String()),
        connection: Type.Optional(
          Type.Object({
            databaseEnv: Type.Optional(Type.String()),
            databaseValue: Type.Optional(Type.String()),
            usernameEnv: Type.Optional(Type.String()),
            usernameValue: Type.Optional(Type.String()),
            passwordEnv: Type.Optional(Type.String()),
            passwordValue: Type.Optional(Type.String()),
            uriTemplate: Type.Optional(Type.String()),
            notes: Type.Optional(Type.String())
          })
        )
      }),
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
        env: Type.Optional(Type.Record(Type.String(), Type.String()))
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
        const thread = typedParams.threadId ? access.store.getThread(typedParams.threadId) ?? null : null;
        const stack = access.getValidatedStack(typedParams.stackId?.trim() || null, typedParams.threadId ?? null);
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
          const filePath = `${worktreePath}/${template.fileName ?? ".manor/sqlite/app.db"}`.replace(/\/+/g, "/");
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          const handle = await fs.open(filePath, "a");
          await handle.close();
          const lease = toServiceLeaseView({
            id: serviceId,
            threadId: typedParams.threadId ?? null,
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
          return {
            content: [{ type: "text", text: `Provisioned ${template.label}. ${lease.connection.uri ?? filePath}` }],
            details: { service: lease }
          };
        }

        const service = await access.runtimeBroker.createService({
          serviceId,
          threadId: typedParams.threadId ?? null,
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
        return {
          content: [
            {
              type: "text",
              text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.${lease.sticky ? ` Sticky volume=${lease.volumeName}.` : ""}`
            }
          ],
          details: { service: lease }
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
        const services = access.store.listServiceLeases();
        const summary =
          services.length === 0
            ? "No disposable services are active."
            : services
                .map(
                  (service, index) =>
                    `${index + 1}. ${service.title} | template=${service.templateId} | status=${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | host=${service.connection.host} | port=${service.connection.port} | uri=${service.connection.uri ?? "(none)"}`
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
        serviceId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("inspect_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string };
        const existing = access.requireValidatedService(typedParams.serviceId, null);
        if (existing.runtimeKind === "embedded") {
          access.store.noteServiceLeaseActivity(existing.id);
          return {
            content: [{ type: "text", text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.` }],
            details: { service: existing }
          };
        }
        const inspected = await access.runtimeBroker.inspectService(existing.id);
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
        serviceId: Type.String(),
        tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
      }),
      uiEffects: access.getToolUiEffects("service_logs"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string; tail?: number };
        const service = access.requireValidatedService(typedParams.serviceId, null);
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
        serviceId: Type.String(),
        command: Type.String({ minLength: 1 }),
        cwd: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("exec_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string; command: string; cwd?: string };
        const service = access.requireValidatedService(typedParams.serviceId, null);
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
        serviceId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("stop_service"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { serviceId: string };
        const service = access.requireValidatedService(typedParams.serviceId, null);
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
