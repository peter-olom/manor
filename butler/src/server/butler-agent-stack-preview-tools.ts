import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { decoratePreviewVerification } from "./preview-verification.js";
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import { normalizeStackStorageMode } from "./stack-storage.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { isSharedShellRepoBootstrapTask } from "./thread-contract.js";
import { applyWorkspacePreviewDefaults, inspectWorkspaceBootstrap } from "./workspace-bootstrap.js";

export function buildButlerStackPreviewTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "prepare_worktree",
      label: "Prepare worktree",
      description: "Create an explicitly requested isolated branch and worktree for one repo task.",
      promptSnippet: "prepare_worktree: use this only when the operator explicitly wants branch or worktree isolation.",
      parameters: Type.Object({
        cwd: Type.String(),
        task: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("prepare_worktree"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { cwd: string; task: string };
        const workspace = await access.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
        return {
          content: [
            {
              type: "text",
              text: workspace.branchName
                ? `Prepared worktree ${workspace.cwd} on branch ${workspace.branchName}.`
                : `No git worktree was needed. Using ${workspace.cwd}.`
            }
          ],
          details: workspace
        };
      }
    }),
    access.defineButlerTool({
      name: "list_stacks",
      label: "List stacks",
      description: "List the active stack leases and their isolated networks.",
      promptSnippet: "list_stacks: inspect stack-backed environments before creating another multi-container runtime.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_stacks"),
      execute: async () => {
        const stacks = access.store.listStackLeases();
        const text =
          stacks.length === 0
            ? "No stack leases are active."
            : stacks
                .map(
                  (stack, index) =>
                    `${index + 1}. ${stack.title} | thread=${stack.threadId ?? "(none)"} | status=${stack.status} | network=${stack.networkName} | ${access.describeStackStorage(stack)} | previews=${stack.previewIds.length} | services=${stack.serviceIds.length}`
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { stacks }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_stack",
      label: "Start stack",
      description: "Create one isolated stack lease and network for a multi-container job.",
      promptSnippet:
        "start_stack: use this before launching multiple cooperating previews or services for one job. Prefer storageMode=job for recurring mutable databases so each job gets its own writable fork from the project base. Use storageMode=base only when intentionally seeding or refreshing the shared base state.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1 }),
        cwd: Type.Optional(Type.String()),
        storageMode: Type.Optional(
          Type.Union([Type.Literal("ephemeral"), Type.Literal("job"), Type.Literal("base"), Type.Literal("custom")])
        ),
        retainsVolumes: Type.Optional(Type.Boolean()),
        storageKey: Type.Optional(Type.String()),
        cloneFromStorageKey: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("start_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId?: string;
          title: string;
          cwd?: string;
          storageMode?: "ephemeral" | "job" | "base" | "custom";
          retainsVolumes?: boolean;
          storageKey?: string;
          cloneFromStorageKey?: string;
        };
        const thread = typedParams.threadId ? access.store.getThread(typedParams.threadId) ?? null : null;
        const worktreePath = typedParams.cwd?.trim() || thread?.cwd || null;
        const project = access.resolveWorkspaceProject(
          worktreePath,
          thread?.supervisor.projectId ?? "stack",
          thread?.supervisor.projectLabel ?? "stack"
        );
        const stack = await access.runtimeBroker.createStack({
          stackId: crypto.randomUUID(),
          threadId: typedParams.threadId ?? null,
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title.trim(),
          worktreePath,
          storageMode: normalizeStackStorageMode(typedParams.storageMode) ?? null,
          retainsVolumes: Boolean(typedParams.retainsVolumes),
          storageKey: typedParams.storageKey?.trim() || null,
          cloneFromStorageKey: typedParams.cloneFromStorageKey?.trim() || null
        });
        access.store.upsertStackLease(stack);
        return {
          content: [
            {
              type: "text",
              text: `Started stack ${stack.title}. Network=${stack.networkName}. ${access.describeStackStorage(stack)}.`
            }
          ],
          details: { stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "inspect_stack",
      label: "Inspect stack",
      description: "Inspect one stack lease and return its current state.",
      promptSnippet: "inspect_stack: use this to confirm what a multi-container environment already contains before changing it.",
      parameters: Type.Object({
        stackId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("inspect_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string };
        const stack = await access.runtimeBroker.inspectStack(typedParams.stackId);
        access.store.upsertStackLease(stack);
        access.store.noteStackLeaseActivity(typedParams.stackId);
        return {
          content: [
            {
              type: "text",
              text: `${stack.title} is ${stack.status}. Network=${stack.networkName}. ${access.describeStackStorage(stack)}. Previews=${stack.previewIds.length}. Services=${stack.serviceIds.length}.`
            }
          ],
          details: { stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "promote_stack",
      label: "Promote stack",
      description: "Copy a stack's retained volumes into another storage namespace.",
      promptSnippet: "promote_stack: use this when one job's retained database or object-store state should become the new shared base.",
      parameters: Type.Object({
        stackId: Type.String(),
        targetStorageKey: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("promote_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string; targetStorageKey?: string };
        const promotion = await access.runtimeBroker.promoteStack({
          stackId: typedParams.stackId,
          targetStorageKey: typedParams.targetStorageKey?.trim() || null
        });
        const stack = await access.runtimeBroker.inspectStack(typedParams.stackId);
        access.store.upsertStackLease(stack);
        access.store.noteStackLeaseActivity(typedParams.stackId);
        return {
          content: [
            {
              type: "text",
              text: `Promoted ${promotion.promotedVolumes.length} volumes from ${promotion.sourceStorageKey} to ${promotion.targetStorageKey}.`
            }
          ],
          details: { promotion, stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_stack",
      label: "Stop stack",
      description: "Stop one stack lease, remove its members, and release its network.",
      promptSnippet: "stop_stack: use this to tear down a whole multi-container environment once the job is done.",
      parameters: Type.Object({
        stackId: Type.String(),
        dropVolumes: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("stop_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string; dropVolumes?: boolean };
        const dropVolumes = typedParams.dropVolumes !== false;
        await access.runtimeBroker.stopStack(typedParams.stackId, { dropVolumes });
        access.removeStackArtifacts(typedParams.stackId);
        return {
          content: [
            {
              type: "text",
              text: `Stopped stack ${typedParams.stackId}.${dropVolumes ? " Dropped retained volumes." : ""}`
            }
          ],
          details: { stackId: typedParams.stackId, dropVolumes }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_previews",
      label: "List previews",
      description: "List the active preview leases and their operator-facing URLs.",
      promptSnippet: "list_previews: inspect live preview routes before asking where to review a running app.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_previews"),
      execute: async () => {
        const syncError = await access.refreshRuntimeInventoryIfAvailable();
        const leases = access.store.listPreviewLeases();
        const summary =
          leases.length === 0
            ? "No preview leases are active."
            : leases
                .map(
                  (lease, index) =>
                    `${index + 1}. ${lease.title} | thread=${lease.threadId ?? "(none)"} | status=${lease.status}/${lease.bootstrap.phase} | route=${lease.operatorUrl}`
                )
                .join("\n");
        const text = syncError ? `Live runtime sync failed; showing cached state. ${syncError}\n${summary}` : summary;
        return {
          content: [{ type: "text", text }],
          details: { previews: leases, syncError }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_preview",
      label: "Start preview",
      description: "Start a disposable preview runtime on the internal Manor network and expose it through a stable route.",
      promptSnippet: "start_preview: use this when a job needs a live reviewable app preview instead of a raw host port.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1 }),
        command: Type.String({ minLength: 1 }),
        port: Type.Number({ minimum: 1, maximum: 65535 }),
        workspaceMode: Type.Optional(
          Type.Union([Type.Literal("shared"), Type.Literal("snapshot")], {
            description: "shared keeps the preview on the source worktree; snapshot copies into an isolated disposable workspace."
          })
        ),
        stackId: Type.Optional(Type.String()),
        aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        image: Type.Optional(Type.String()),
        egressProfile: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Defaults to direct internet access. Use 'none' to block outbound traffic or a named preview egress profile such as 'web' to restrict it."
          })
        ),
        egressDomains: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              description: "Explicit domain allowlist for this preview only, such as api.openrouter.ai or .cloudflare.com."
            })
          )
        ),
        bootstrapWaitSeconds: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "How long the preview may spend bootstrapping before the heartbeat is treated as failed."
          })
        ),
        bootstrapHint: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Short hint like 'installing deps' or 'running migrations'."
          })
        ),
        heartbeatKind: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Heartbeat type: none, http, tcp, or command. Defaults to http for previews."
          })
        ),
        heartbeatTarget: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Heartbeat target such as /health, 127.0.0.1:3000, or a shell command. Defaults to / when the heartbeat kind is omitted."
          })
        ),
        heartbeatIntervalSeconds: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "How often Manor should retry the heartbeat during bootstrap."
          })
        )
      }),
      uiEffects: access.getToolUiEffects("start_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId?: string;
          cwd: string;
          title: string;
          command: string;
          port: number;
          workspaceMode?: "shared" | "snapshot";
          stackId?: string;
          aliases?: string[];
          env?: Record<string, string>;
          image?: string;
          egressProfile?: string;
          egressDomains?: string[];
          bootstrapWaitSeconds?: number;
          bootstrapHint?: string;
          heartbeatKind?: string;
          heartbeatTarget?: string;
          heartbeatIntervalSeconds?: number;
        };

        const thread = typedParams.threadId ? access.store.getThread(typedParams.threadId) ?? null : null;
        const stack = access.getValidatedStack(typedParams.stackId?.trim() || null, typedParams.threadId ?? null);
        const leaseId = crypto.randomUUID();
        const worktreePath = typedParams.cwd?.trim() || stack?.worktreePath || thread?.cwd || "";
        const project = access.resolveWorkspaceProject(
          worktreePath,
          thread?.supervisor.projectId ?? "preview",
          thread?.supervisor.projectLabel ?? "preview"
        );

        if (!worktreePath) {
          throw new Error("start_preview requires a cwd or a stack with a worktree path");
        }

        const workspaceBootstrap = await inspectWorkspaceBootstrap(worktreePath);
        const previewDefaults = applyWorkspacePreviewDefaults(
          {
            image: typedParams.image,
            egressProfile: typedParams.egressProfile ?? "internet",
            egressDomains: typedParams.egressDomains,
            bootstrapHint: typedParams.bootstrapHint
          },
          workspaceBootstrap
        );

        const lease = await access.runtimeBroker.createLease({
          leaseId,
          threadId: typedParams.threadId ?? null,
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title,
          stackId: stack?.id ?? null,
          aliases: access.normalizeStringArray(typedParams.aliases),
          worktreePath,
          branchName: thread?.cwd === typedParams.cwd ? null : null,
          targetPort: typedParams.port,
          command: typedParams.command,
          workspaceMode: typedParams.workspaceMode === "snapshot" ? "snapshot" : "shared",
          image: previewDefaults.image,
          egressProfile: previewDefaults.egressProfile ?? "internet",
          egressDomains: previewDefaults.egressDomains ?? [],
          bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
          bootstrapHint: previewDefaults.bootstrapHint,
          heartbeatKind: typedParams.heartbeatKind as "none" | "http" | "tcp" | "command" | undefined,
          heartbeatTarget: typedParams.heartbeatTarget,
          heartbeatIntervalSeconds: typedParams.heartbeatIntervalSeconds,
          env: access.normalizeServiceEnv(typedParams.env)
        });
        access.store.upsertPreviewLease(lease);

        return {
          content: [
            {
              type: "text",
              text: `Started preview ${lease.title} at ${lease.operatorUrl}. Workspace=${lease.workspaceMode}. Bootstrap=${lease.bootstrap.phase}${lease.bootstrap.hint ? ` (${lease.bootstrap.hint})` : ""}.${previewDefaults.autofilled.length > 0 ? ` Auto-filled ${previewDefaults.autofilled.join(", ")} from workspace bootstrap.` : ""}`
            }
          ],
          details: { lease, workspaceBootstrap, previewDefaults }
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_preview",
      label: "Stop preview",
      description: "Stop a preview runtime and release its lease.",
      promptSnippet: "stop_preview: use this when preview work is done or a stale preview should be cleaned up.",
      parameters: Type.Object({
        leaseId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("stop_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        access.store.markPreviewLeaseStopping(typedParams.leaseId);
        await access.runtimeBroker.stopLease(typedParams.leaseId);
        access.store.removePreviewLease(typedParams.leaseId);
        return {
          content: [{ type: "text", text: `Stopped preview ${typedParams.leaseId}.` }],
          details: { leaseId: typedParams.leaseId }
        };
      }
    }),
    access.defineButlerTool({
      name: "inspect_preview",
      label: "Inspect preview",
      description: "Inspect one preview isolate and summarize its current runtime state.",
      promptSnippet: "inspect_preview: use this before diagnosing a preview so you know whether it is running, what route it has, and what egress policy it carries.",
      parameters: Type.Object({
        leaseId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("inspect_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        const lease = await access.runtimeBroker.inspectLease(typedParams.leaseId);
        access.store.upsertPreviewLease(lease);
        access.store.notePreviewLeaseActivity(typedParams.leaseId);
        const domains = lease.egressDomains.length > 0 ? lease.egressDomains.join(", ") : "(none)";
        return {
          content: [
            {
              type: "text",
              text: `${lease.title} is ${lease.runtime.status}. Bootstrap=${lease.bootstrap.phase}. Workspace=${lease.workspaceMode}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}. Domains=${domains}.`
            }
          ],
          details: { lease }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_preview_browser_session",
      label: "Start preview browser session",
      description: "Attach a browser sidecar to one preview and begin a live recorded session.",
      promptSnippet:
        "start_preview_browser_session: open a live browser session for a preview. The timer and recording begin immediately; stop the session later to persist proof.",
      parameters: Type.Object({
        leaseId: Type.String(),
        mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("headful")])),
        path: Type.Optional(Type.String()),
        targetUrl: Type.Optional(Type.String()),
        waitForSelector: Type.Optional(Type.String()),
        postLoadWaitMs: Type.Optional(Type.Number({ minimum: 0 })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
        sessionCookie: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("start_preview_browser_session"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          leaseId: string;
          mode?: "headless" | "headful";
          path?: string;
          targetUrl?: string;
          waitForSelector?: string;
          postLoadWaitMs?: number;
          headers?: Record<string, string>;
          cookies?: Record<string, string>;
          sessionCookie?: string;
        };
        const preview = access.requireValidatedPreview(typedParams.leaseId, null);
        const cookieEntries = Object.entries(typedParams.cookies ?? {})
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
          .map(([name, value]) => [name.trim(), value.trim()] as const)
          .filter(([name, value]) => name.length > 0 && value.length > 0);
        const sessionCookie = typeof typedParams.sessionCookie === "string" ? typedParams.sessionCookie.trim() : "";
        if (sessionCookie) {
          cookieEntries.push(["better-auth.session_token", sessionCookie]);
        }
        const session = await access.runtimeBroker.startPreviewBrowserSession({
          leaseId: preview.id,
          mode: typedParams.mode === "headful" ? "headful" : "headless",
          path: typedParams.path?.trim() || undefined,
          targetUrl: typedParams.targetUrl?.trim() || undefined,
          waitForSelector: typedParams.waitForSelector?.trim() || undefined,
          postLoadWaitMs:
            typeof typedParams.postLoadWaitMs === "number" && Number.isFinite(typedParams.postLoadWaitMs)
              ? Math.max(0, Math.trunc(typedParams.postLoadWaitMs))
              : undefined,
          headers: typedParams.headers && Object.keys(typedParams.headers).length > 0 ? typedParams.headers : undefined,
          cookies: cookieEntries.length > 0 ? cookieEntries.map(([name, value]) => ({ name, value })) : undefined
        });
        access.store.notePreviewLeaseActivity(preview.id);

        return {
          content: [
            {
              type: "text",
              text: `Started browser session ${session.sessionId} for ${preview.title}. Recording is live until the session is stopped.`
            }
          ],
          details: {
            preview,
            session
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_browser_session",
      label: "Start browser session",
      description: "Start a live recorded browser session for a direct URL.",
      promptSnippet:
        "start_browser_session: open a live browser session for a direct URL. Proof is persisted only after stop_browser_session.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        targetUrl: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("headful")])),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
        sessionCookie: Type.Optional(Type.String()),
        waitForSelector: Type.Optional(Type.String()),
        postLoadWaitMs: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      uiEffects: access.getToolUiEffects("start_browser_session"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId?: string;
          targetUrl: string;
          title?: string;
          mode?: "headless" | "headful";
          headers?: Record<string, string>;
          cookies?: Record<string, string>;
          sessionCookie?: string;
          waitForSelector?: string;
          postLoadWaitMs?: number;
        };
        const threadId = typedParams.threadId?.trim() || null;
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = thread?.cwd || "";
        const project = access.resolveWorkspaceProject(
          cwd,
          thread?.supervisor.projectId ?? "browser",
          thread?.supervisor.projectLabel ?? "browser"
        );
        const cookieEntries = Object.entries(typedParams.cookies ?? {})
          .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
          .map(([name, value]) => [name.trim(), value.trim()] as const)
          .filter(([name, value]) => name.length > 0 && value.length > 0);
        const sessionCookie = typeof typedParams.sessionCookie === "string" ? typedParams.sessionCookie.trim() : "";
        if (sessionCookie) {
          cookieEntries.push(["better-auth.session_token", sessionCookie]);
        }
        const session = await access.runtimeBroker.startBrowserSession({
          threadId: threadId ?? "browser",
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title?.trim() || typedParams.targetUrl.trim(),
          targetUrl: typedParams.targetUrl.trim(),
          mode: typedParams.mode === "headful" ? "headful" : "headless",
          headers: typedParams.headers && Object.keys(typedParams.headers).length > 0 ? typedParams.headers : undefined,
          cookies: cookieEntries.length > 0 ? cookieEntries.map(([name, value]) => ({ name, value })) : undefined,
          waitForSelector: typedParams.waitForSelector?.trim() || undefined,
          postLoadWaitMs:
            typeof typedParams.postLoadWaitMs === "number" && Number.isFinite(typedParams.postLoadWaitMs)
              ? Math.max(0, Math.trunc(typedParams.postLoadWaitMs))
              : undefined
        });

        return {
          content: [
            {
              type: "text",
              text: `Started browser session ${session.sessionId}. Recording is live until the session is stopped.`
            }
          ],
          details: {
            session
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "browser_session_state",
      label: "Browser session state",
      description: "Inspect one active browser session state.",
      promptSnippet: "browser_session_state: use this to confirm session health, URL, and action count before continuing.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("browser_session_state"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { sessionId: string };
        const result = await access.runtimeBroker.inspectBrowserSession(typedParams.sessionId.trim());
        return {
          content: [
            {
              type: "text",
              text: `Session ${result.session.sessionId} is active at ${result.session.url}. Actions=${result.session.actionCount}.`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "browser_session_action",
      label: "Browser session action",
      description: "Run one explicit action in an active browser session, including manual screenshots.",
      promptSnippet:
        "browser_session_action: use this for stepwise browser control. Use actionType=screenshot at any checkpoint where visual proof should be captured.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        actionType: Type.String({ minLength: 1 }),
        selector: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        values: Type.Optional(Type.Array(Type.String())),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        script: Type.Optional(Type.String()),
        ms: Type.Optional(Type.Number({ minimum: 0 })),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        delayMs: Type.Optional(Type.Number({ minimum: 0 })),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
        label: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        autoCapture: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("browser_session_action"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          sessionId: string;
          actionType: string;
          selector?: string;
          value?: string;
          values?: string[];
          text?: string;
          key?: string;
          url?: string;
          urlIncludes?: string;
          script?: string;
          ms?: number;
          x?: number;
          y?: number;
          delayMs?: number;
          timeoutMs?: number;
          label?: string;
          fileName?: string;
          autoCapture?: boolean;
        };

        const result = await access.runtimeBroker.runBrowserSessionAction(typedParams.sessionId.trim(), {
          type: typedParams.actionType.trim(),
          selector: typedParams.selector?.trim() || undefined,
          value: typedParams.value?.trim() || undefined,
          values: Array.isArray(typedParams.values) ? typedParams.values.map((entry) => entry.trim()).filter(Boolean) : [],
          text: typedParams.text || undefined,
          key: typedParams.key?.trim() || undefined,
          url: typedParams.url?.trim() || undefined,
          urlIncludes: typedParams.urlIncludes?.trim() || undefined,
          script: typedParams.script,
          ms:
            typeof typedParams.ms === "number" && Number.isFinite(typedParams.ms)
              ? Math.max(0, Math.trunc(typedParams.ms))
              : undefined,
          x: typeof typedParams.x === "number" && Number.isFinite(typedParams.x) ? typedParams.x : undefined,
          y: typeof typedParams.y === "number" && Number.isFinite(typedParams.y) ? typedParams.y : undefined,
          delayMs:
            typeof typedParams.delayMs === "number" && Number.isFinite(typedParams.delayMs)
              ? Math.max(0, Math.trunc(typedParams.delayMs))
              : undefined,
          timeoutMs:
            typeof typedParams.timeoutMs === "number" && Number.isFinite(typedParams.timeoutMs)
              ? Math.max(0, Math.trunc(typedParams.timeoutMs))
              : undefined,
          label: typedParams.label?.trim() || undefined,
          fileName: typedParams.fileName?.trim() || undefined,
          autoCapture: typedParams.autoCapture
        });

        return {
          content: [
            {
              type: "text",
              text: `Browser action ${result.action.type} completed. URL=${result.state.url}. Actions=${result.state.actionCount}.`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_browser_session",
      label: "Stop browser session",
      description: "Stop a browser session and persist the final proof bundle.",
      promptSnippet:
        "stop_browser_session: finalize browser proof. This stops the timer and saves one video plus captured screenshots.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        reason: Type.Optional(Type.String()),
        leaseId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("stop_browser_session"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          sessionId: string;
          reason?: string;
          leaseId?: string;
        };

        const result = await access.runtimeBroker.stopBrowserSession(
          typedParams.sessionId.trim(),
          typedParams.reason?.trim() || undefined
        );
        const verification = decoratePreviewVerification(result.verification);

        if (result.browserProof) {
          access.store.recordBrowserVerification({
            threadId: result.browserProof.threadId,
            projectId: result.browserProof.projectId,
            projectLabel: result.browserProof.projectLabel,
            title: result.browserProof.title,
            verification
          });
        } else {
          const effectivePreviewLeaseId =
            typedParams.leaseId?.trim() || (result.tracked?.kind === "preview" ? result.tracked.leaseId : null);
          if (effectivePreviewLeaseId) {
            access.store.recordPreviewLeaseVerification(effectivePreviewLeaseId, verification);
            access.store.notePreviewLeaseActivity(effectivePreviewLeaseId);
          }
        }

        const screenshots = verification.artifacts.filter((artifact) => artifact.kind === "screenshot");
        const video = verification.artifacts.find((artifact) => artifact.kind === "video") ?? null;
        const remediationHint = verification.failureKind !== "none" ? verification.diagnostics?.remediationHints?.[0] ?? "" : "";
        const signalSummary =
          verification.failureKind === "none"
            ? "Signals=none."
            : `Signals=${verification.failureKind}.${verification.status ? ` Status=${verification.status}.` : ""}${remediationHint ? ` Hint=${remediationHint}.` : ""}`;

        return {
          content: [
            {
              type: "text",
              text: `Stopped browser session with proof run ${verification.runId}. Saved ${screenshots.length} screenshots and ${video ? "1 video" : "no video"}. ${signalSummary}`
            }
          ],
          details: {
            verification,
            screenshots,
            video,
            browserProof: result.browserProof ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "review_preview_proof",
      label: "Review preview proof",
      description: "Inspect the latest Playwright screenshots for one preview or job and decide whether the recorded proof is convincing.",
      promptSnippet:
        "review_preview_proof: use this when frontend execution proof is demanded. Do not sign off until the screenshot has been reviewed and the recorded proof is clearly convincing.",
      parameters: Type.Object({
        leaseId: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
        expectedOutcome: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("review_preview_proof"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          leaseId?: string;
          threadId?: string;
          runId?: string;
          expectedOutcome?: string;
        };

        const proof = access.resolvePreviewProof({
          leaseId: typedParams.leaseId?.trim(),
          threadId: typedParams.threadId?.trim(),
          runId: typedParams.runId?.trim()
        });
        const review = await access.reviewProofScreenshot(proof, {
          expectedOutcome: typedParams.expectedOutcome
        });

        const videoRequirementMet = Boolean(proof.video?.downloadUrl ?? proof.video?.url);
        const proofVerdict = videoRequirementMet ? review.verdict : "incomplete";
        const screenshotSummary =
          proof.screenshots.length > 0
            ? `${proof.screenshots.length} recorded (${proof.screenshots
                .slice(0, 3)
                .map((artifact) => artifact.label)
                .join(", ")}${proof.screenshots.length > 3 ? ", ..." : ""})`
            : "none";
        const proofSummary = [
          `Verdict=${proofVerdict}`,
          `FailureKind=${proof.verification.failureKind}`,
          `Visible=${review.visibleState}`,
          `Evidence=${review.evidence}`,
          `Concern=${videoRequirementMet ? review.concern : "Recorded video proof is missing."}`,
          `RecordedVideo=${videoRequirementMet ? "yes" : "no"}`,
          `Screenshots=${screenshotSummary}`
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: [`Reviewed proof for ${proof.preview.title}.`, proofSummary].join("\n")
            }
          ],
          details: {
            preview: proof.preview,
            verification: proof.verification,
            screenshots: proof.screenshots,
            screenshot: proof.primaryScreenshot,
            video: proof.video,
            manifest: proof.manifest,
            trace: proof.trace,
            review,
            proofComplete: videoRequirementMet
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "preview_processes",
      label: "Preview processes",
      description: "List processes running inside one preview isolate.",
      promptSnippet: "preview_processes: use this when a preview seems stuck and you need to see the running process table.",
      parameters: Type.Object({
        leaseId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("preview_processes"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        const result = await access.runtimeBroker.listProcesses(typedParams.leaseId);
        access.store.notePreviewLeaseActivity(typedParams.leaseId);
        const rows =
          result.processes.length === 0
            ? "No processes were reported."
            : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
        return {
          content: [{ type: "text", text: rows }],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "preview_logs",
      label: "Preview logs",
      description: "Read recent logs from one preview isolate.",
      promptSnippet: "preview_logs: use this when a preview boot or app route is failing and you need the recent container output.",
      parameters: Type.Object({
        leaseId: Type.String(),
        tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
      }),
      uiEffects: access.getToolUiEffects("preview_logs"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string; tail?: number };
        const result = await access.runtimeBroker.readLogs(typedParams.leaseId, typedParams.tail ?? 200);
        access.store.notePreviewLeaseActivity(typedParams.leaseId);
        return {
          content: [{ type: "text", text: result.logs || "No logs were returned." }],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "exec_preview",
      label: "Exec in preview",
      description: "Run one shell command inside a preview isolate through the runtime broker.",
      promptSnippet: "exec_preview: use this when Butler needs to inspect or patch a preview isolate directly without opening the shared terminal.",
      parameters: Type.Object({
        leaseId: Type.String(),
        command: Type.String({ minLength: 1 }),
        cwd: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("exec_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string; command: string; cwd?: string };
        const result = await access.runtimeBroker.execInLease(typedParams);
        access.store.notePreviewLeaseActivity(typedParams.leaseId);
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
    })
  ];
}

export function buildButlerDelegationTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "delegate_to_codex",
      label: "Delegate to Codex",
      description: "Start a new Codex workstream for an execution task such as repo cloning, project setup, coding work, or command execution.",
      promptSnippet:
        "delegate_to_codex: use this when the operator is asking for real execution, coding, shell work, repo setup, or other task delivery by Codex.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        goal: Type.Optional(Type.String({ minLength: 1 })),
        cwd: Type.Optional(Type.String()),
        imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        fileReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
      }),
      uiEffects: access.getToolUiEffects("delegate_to_codex"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          task: string;
          goal?: string;
          cwd?: string;
          imageReferenceIds?: string[];
          fileReferenceIds?: string[];
        };
        const smokeRequest = access.detectSupervisionSmokeRequest(typedParams.task, typedParams.goal);
        const workspace = smokeRequest
          ? { cwd: "/repos", branchName: null as string | null }
          : await access.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
        const delegatedTask = smokeRequest ? access.buildSupervisionSmokeTask(smokeRequest.totalFollowUps) : typedParams.task;
        const delegatedGoal = smokeRequest ? undefined : typedParams.goal;
        const repoBootstrapTask = !smokeRequest && isSharedShellRepoBootstrapTask(delegatedTask);
        const developerInstructions = await access.buildDelegationDeveloperInstructions(workspace, delegatedTask);
        const extraNotes = smokeRequest
          ? {
              notes: ["Synthetic Butler supervision smoke test. Do not gather proof unless the smoke test explicitly asks for it."]
            }
          : repoBootstrapTask
            ? {
                notes: ["This job starts in the shared /repos workspace. Create or clone the repo first, then continue inside that repo."]
              }
            : { notes: undefined };

        const result = await access.codexClient.startThread({
          task: delegatedGoal ? `${delegatedTask}\n\nGoal: ${delegatedGoal}` : delegatedTask,
          input: async (threadId: string) =>
            buildCodexInputWithReferences({
              text: (
                await access.buildDelegationContract({
                  threadId,
                  task: delegatedTask,
                  goal: delegatedGoal,
                  workspace,
                  extraNotes: extraNotes.notes
                })
              ).text,
              imageStore: access.imageStore,
              imageReferenceIds: typedParams.imageReferenceIds ?? [],
              fileStore: access.fileStore,
              fileReferenceIds: typedParams.fileReferenceIds ?? []
            }),
          cwd: workspace.cwd,
          developerInstructions,
          openWindow: true
        });
        const delegationContract = await access.buildDelegationContract({
          threadId: result.threadId,
          task: delegatedTask,
          goal: delegatedGoal,
          workspace,
          extraNotes: extraNotes.notes
        });
        access.store.setThreadExecutionContract(result.threadId, delegationContract.contract);
        access.store.addEvent(result.threadId, "butler.delegation.created", "Butler created the job brief for this delegated job.");
        access.noteThreadFocus(result.threadId, "delegate_to_codex");
        access.queueDelegationAcknowledgement(
          result.threadId,
          smokeRequest
            ? `Accepted. I started a supervision smoke test in job ${result.threadId}. I will return here when it completes.`
            : `Accepted. I delegated this to Codex in job ${result.threadId} and will return here with the result.`
        );
        access.registerPendingChatCallback(result.threadId);
        if (smokeRequest) {
          access.store.setThreadSupervisionLimit(result.threadId, smokeRequest.totalFollowUps + 2);
          access.supervisionSmokePlans.set(result.threadId, {
            threadId: result.threadId,
            totalFollowUps: smokeRequest.totalFollowUps,
            followUpsSent: 0
          });
        }
        const supervision = access.store.noteButlerSteer(result.threadId);

        return {
          content: [
            {
              type: "text",
              text: smokeRequest
                ? `Started supervision smoke test in job ${result.threadId}. Butler will privately steer ${smokeRequest.totalFollowUps} follow-up turns. Budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
                : `Delegated the task to Codex in job ${result.threadId} from ${workspace.cwd}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
            }
          ],
          details: {
            threadId: result.threadId,
            totalFollowUps: smokeRequest?.totalFollowUps ?? null,
            supervision,
            workspace,
            thread: access.store.getThread(result.threadId) ?? null
          }
        };
      }
    })
  ];
}
