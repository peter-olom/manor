import { Type } from "@sinclair/typebox";

import {
  decorateProjectArtifactWithAccess,
  formatProjectArtifactAccessLine,
  getProjectArtifactUserDownloadUrl
} from "./project-artifact-access.js";
import {
  buildProjectPolicy,
  createProjectArtifactFromFile,
  createProjectArtifactFromText,
  createProjectArtifactFromUrl,
  findProjectPolicyBySelector,
  invokeProjectPolicy,
  normalizeArtifactMetadata,
  resolveProjectPolicyArtifactIds,
  readProjectArtifactContent
} from "./project-artifacts-policies.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { formatButlerMemoryRetrieval, retrieveButlerMemory } from "./memory-retrieval.js";

function hasOwnField(value: unknown, key: string): boolean {
  return Boolean(value) && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

export function buildButlerProjectTools(access: ButlerAgentToolAccess, artifactsDir: string): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "remember_insight",
      label: "Remember insight",
      description: "Store a durable Butler memory for important operator preferences, decisions, reusable ideas, or context from the main chat.",
      promptSnippet: "remember_insight: use this when the operator asks Butler to remember something or when a valuable reusable insight should survive chat cleanup.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1 }),
        details: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String()))
      }),
      uiEffects: access.getToolUiEffects("remember_insight"),
      execute: async (_toolCallId, params) => {
        const entry = access.store.recordButlerMemory({
          summary: params.summary as string,
          details: typeof params.details === "string" ? params.details : null,
          source: "butler_tool",
          tags: params.tags
        });
        return {
          content: [{ type: "text", text: `Remembered: ${entry.summary}` }],
          details: { entry }
        };
      }
    }),
    access.defineButlerTool({
      name: "retrieve_memory",
      label: "Retrieve memory",
      description: "Retrieve a scoped durable memory brief for a project, job, or stateful operator question without mutating memory.",
      promptSnippet:
        "retrieve_memory: use for stateful project questions, cross-thread follow-ups, prior decisions, unresolved outcomes, or when the operator expects Butler to remember work; skip it for casual chat.",
      parameters: Type.Object({
        projectId: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
        includeGlobal: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("retrieve_memory"),
      execute: async (_toolCallId, params) => {
        const retrieval = retrieveButlerMemory(access.store, {
          projectId: typeof params.projectId === "string" ? params.projectId : null,
          threadId: typeof params.threadId === "string" ? params.threadId : null,
          query: typeof params.query === "string" ? params.query : null,
          limit: typeof params.limit === "number" ? params.limit : null,
          includeGlobal: typeof params.includeGlobal === "boolean" ? params.includeGlobal : false
        });
        return {
          content: [{ type: "text", text: formatButlerMemoryRetrieval(retrieval) }],
          details: { retrieval }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_project_artifacts",
      label: "List project artifacts",
      description: "List durable project artifacts such as seeds, research files, references, and downloaded inputs.",
      promptSnippet: "list_project_artifacts: use this before recreating seed files, fixtures, or reusable reference documents.",
      parameters: Type.Object({
        projectId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("list_project_artifacts"),
      execute: async (_toolCallId, params) => {
        const projectId = typeof params.projectId === "string" && params.projectId.trim() ? params.projectId.trim() : null;
        const artifacts = access.store.listProjectArtifacts(projectId);
        const text =
          artifacts.length === 0
            ? "No durable project artifacts are stored."
            : artifacts.map((artifact, index) => `${index + 1}. ${artifact.kind} | ${formatProjectArtifactAccessLine(artifact)} | ${artifact.sizeBytes} bytes`).join("\n");
        return {
          content: [{ type: "text", text }],
          details: { artifacts: artifacts.map((artifact) => decorateProjectArtifactWithAccess(artifact)) }
        };
      }
    }),
    access.defineButlerTool({
      name: "save_project_artifact",
      label: "Save project artifact",
      description: "Store a durable text artifact for the current project, such as a seed file, report, or research note.",
      promptSnippet: "save_project_artifact: use this when Butler generates a reusable file that should survive outside the repo.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1 }),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("seed"),
            Type.Literal("reference"),
            Type.Literal("download"),
            Type.Literal("research"),
            Type.Literal("report"),
            Type.Literal("other")
          ])
        ),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        contentType: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        metadata: Type.Optional(Type.Record(Type.String(), Type.String()))
      }),
      uiEffects: access.getToolUiEffects("save_project_artifact"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? "/repos";
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const artifact = await createProjectArtifactFromText({
          artifactsDir,
          projectId: project.id,
          projectLabel: project.label,
          threadId: threadId || null,
          kind:
            params.kind === "seed" ||
            params.kind === "reference" ||
            params.kind === "download" ||
            params.kind === "research" ||
            params.kind === "report"
              ? params.kind
              : "other",
          title: params.title as string,
          description: typeof params.description === "string" ? params.description : null,
          fileName: typeof params.fileName === "string" ? params.fileName : null,
          contentType: typeof params.contentType === "string" ? params.contentType : null,
          text: params.text as string,
          tags: Array.isArray(params.tags) ? params.tags : [],
          metadata: normalizeArtifactMetadata(params.metadata)
        });
        access.store.upsertProjectArtifact(artifact);
        return {
          content: [{ type: "text", text: `Saved ${artifact.title} as a durable project artifact.` }],
          details: { artifact: decorateProjectArtifactWithAccess(artifact) }
        };
      }
    }),
    access.defineButlerTool({
      name: "share_project_file",
      label: "Share project file",
      description: "Store an existing local file as a durable project artifact and return a host-clickable download link.",
      promptSnippet: "share_project_file: use this when the operator asks for a download link to an existing local file.",
      parameters: Type.Object({
        sourceFilePath: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("seed"),
            Type.Literal("reference"),
            Type.Literal("download"),
            Type.Literal("research"),
            Type.Literal("report"),
            Type.Literal("other")
          ])
        ),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        contentType: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        metadata: Type.Optional(Type.Record(Type.String(), Type.String()))
      }),
      uiEffects: access.getToolUiEffects("share_project_file"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const sourceFilePath = (params.sourceFilePath as string).trim();
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? sourceFilePath;
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const fileName = typeof params.fileName === "string" && params.fileName.trim() ? params.fileName.trim() : null;
        const artifact = await createProjectArtifactFromFile({
          artifactsDir,
          projectId: project.id,
          projectLabel: project.label,
          threadId: threadId || null,
          kind:
            params.kind === "seed" ||
            params.kind === "reference" ||
            params.kind === "download" ||
            params.kind === "research" ||
            params.kind === "report"
              ? params.kind
              : "download",
          title:
            typeof params.title === "string" && params.title.trim()
              ? params.title.trim()
              : fileName || sourceFilePath.split("/").filter(Boolean).at(-1) || "File download",
          description: typeof params.description === "string" ? params.description : null,
          sourceFilePath,
          fileName,
          contentType: typeof params.contentType === "string" ? params.contentType : null,
          tags: Array.isArray(params.tags) ? params.tags : [],
          metadata: normalizeArtifactMetadata(params.metadata)
        });
        access.store.upsertProjectArtifact(artifact);
        return {
          content: [
            {
              type: "text",
              text: [
                `Download: ${getProjectArtifactUserDownloadUrl(artifact)}`,
                `File name: ${artifact.fileName}`
              ].join("\n")
            }
          ],
          details: { artifact: decorateProjectArtifactWithAccess(artifact) }
        };
      }
    }),
    access.defineButlerTool({
      name: "download_project_artifact",
      label: "Download project artifact",
      description: "Download a file from a URL and store it as a durable project artifact.",
      promptSnippet: "download_project_artifact: use this when the operator provides a reusable external file that Butler should keep for later work.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        url: Type.String({ minLength: 1 }),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("seed"),
            Type.Literal("reference"),
            Type.Literal("download"),
            Type.Literal("research"),
            Type.Literal("report"),
            Type.Literal("other")
          ])
        ),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        contentType: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        metadata: Type.Optional(Type.Record(Type.String(), Type.String()))
      }),
      uiEffects: access.getToolUiEffects("download_project_artifact"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? "/repos";
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const artifact = await createProjectArtifactFromUrl({
          artifactsDir,
          projectId: project.id,
          projectLabel: project.label,
          threadId: threadId || null,
          kind:
            params.kind === "seed" ||
            params.kind === "reference" ||
            params.kind === "download" ||
            params.kind === "research" ||
            params.kind === "report"
              ? params.kind
              : "download",
          title: params.title as string,
          description: typeof params.description === "string" ? params.description : null,
          url: params.url as string,
          fileName: typeof params.fileName === "string" ? params.fileName : null,
          contentType: typeof params.contentType === "string" ? params.contentType : null,
          tags: Array.isArray(params.tags) ? params.tags : [],
          metadata: normalizeArtifactMetadata(params.metadata)
        });
        access.store.upsertProjectArtifact(artifact);
        return {
          content: [{ type: "text", text: `Downloaded ${artifact.title} into durable project storage.` }],
          details: { artifact: decorateProjectArtifactWithAccess(artifact) }
        };
      }
    }),
    access.defineButlerTool({
      name: "read_project_artifact",
      label: "Read project artifact",
      description: "Read one stored project artifact and return its metadata plus text content when applicable.",
      promptSnippet: "read_project_artifact: use this when Butler should inspect an existing durable artifact instead of recomputing it.",
      parameters: Type.Object({
        artifactId: Type.String({ minLength: 1 }),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("read_project_artifact"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? "/repos";
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const artifact = access.store.getProjectArtifact(project.id, (params.artifactId as string).trim());
        if (!artifact) {
          return {
            content: [{ type: "text", text: "Artifact not found." }],
            details: { artifact: null }
          };
        }
        const content = await readProjectArtifactContent(artifact);
        return {
          content: [
            {
              type: "text",
              text: [
                `${artifact.title} | ${artifact.kind} | ${artifact.fileName} | ${artifact.sizeBytes} bytes`,
                `Download: ${getProjectArtifactUserDownloadUrl(artifact)}`,
                content.content ? content.content : "Binary or non-text artifact."
              ].join("\n\n")
            }
          ],
          details: { artifact: decorateProjectArtifactWithAccess(artifact), content: content.content, contentTruncated: content.truncated }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_project_policies",
      label: "List project policies",
      description: "List durable project policies Butler can surface or apply when matching events happen.",
      promptSnippet: "list_project_policies: use this before creating a new remembered rule so Butler reuses or updates an existing policy.",
      parameters: Type.Object({
        projectId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("list_project_policies"),
      execute: async (_toolCallId, params) => {
        const projectId = typeof params.projectId === "string" && params.projectId.trim() ? params.projectId.trim() : null;
        const policies = access.store.listProjectPolicies(projectId);
        const text =
          policies.length === 0
            ? "No durable project policies are stored."
            : policies
                .map(
                  (policy, index) =>
                    `${index + 1}. ${policy.id} | ${policy.title} | triggers=${policy.triggers.join("|") || "none"} | artifacts=${policy.artifacts.join("|") || "none"}`
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { policies }
        };
      }
    }),
    access.defineButlerTool({
      name: "remember_project_policy",
      label: "Remember project policy",
      description: "Create or update a durable project policy bundle that gives Butler or Codex reusable instructions plus artifacts.",
      promptSnippet: "remember_project_policy: use this when the operator wants Butler to remember durable guidance or actions that should be reusable across later work.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        instruction: Type.String({ minLength: 1 }),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        policyId: Type.Optional(Type.String()),
        artifacts: Type.Optional(Type.Array(Type.String())),
        triggers: Type.Optional(Type.Array(Type.String()))
      }),
      uiEffects: access.getToolUiEffects("remember_project_policy"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? "/repos";
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const existingId = typeof params.policyId === "string" && params.policyId.trim() ? params.policyId.trim() : "";
        const existing = existingId ? access.store.getProjectPolicy(project.id, existingId) : null;
        const artifacts = resolveProjectPolicyArtifactIds({
          store: access.store,
          projectId: project.id,
          artifactIds: hasOwnField(params, "artifacts") ? (Array.isArray(params.artifacts) ? params.artifacts : []) : undefined
        });
        const policy = buildProjectPolicy({
          projectId: project.id,
          projectLabel: project.label,
          title: params.title as string,
          instruction: params.instruction as string,
          artifacts,
          triggers: hasOwnField(params, "triggers") ? (Array.isArray(params.triggers) ? params.triggers : []) : undefined,
          policyId: existingId || null,
          existing
        });
        access.store.upsertProjectPolicy(policy);
        return {
          content: [{ type: "text", text: `Saved project policy ${policy.title}.` }],
          details: { policy }
        };
      }
    }),
    access.defineButlerTool({
      name: "invoke_project_policy",
      label: "Invoke project policy",
      description: "Load or execute one remembered policy directly by id, title, or alias.",
      promptSnippet: "invoke_project_policy: use this when the operator explicitly tells Butler or Codex to run or load a remembered policy now.",
      parameters: Type.Object({
        selector: Type.String({ minLength: 1 }),
        projectId: Type.Optional(Type.String()),
        projectLabel: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        serviceId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("invoke_project_policy"),
      execute: async (_toolCallId, params) => {
        const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : thread?.cwd ?? "/repos";
        const project = access.resolveWorkspaceProject(
          cwd,
          (typeof params.projectId === "string" && params.projectId.trim()) || thread?.supervisor.projectId || "project",
          (typeof params.projectLabel === "string" && params.projectLabel.trim()) || thread?.supervisor.projectLabel || "project"
        );
        const policy = findProjectPolicyBySelector({
          store: access.store,
          projectId: project.id,
          selector: params.selector as string
        });
        if (!policy) {
          return {
            content: [{ type: "text", text: "Project policy not found." }],
            details: { policy: null }
          };
        }
        const service =
          typeof params.serviceId === "string" && params.serviceId.trim()
            ? access.store.getServiceLease(params.serviceId.trim()) ?? null
            : null;
        const stack = service?.stackId ? access.store.getStackLease(service.stackId) ?? null : null;
        const result = await invokeProjectPolicy({
          store: access.store,
          runtimeBroker: access.runtimeBroker,
          policy,
          service,
          stack
        });
        return {
          content: [{ type: "text", text: result.message }],
          details: { policy, result }
        };
      }
    })
  ];
}
