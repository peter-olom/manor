import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { decoratePreviewVerification } from "./preview-verification.js";
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import { buildButlerStackTools } from "./butler-agent-stack-tools.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import type { ReasoningEffort } from "./types.js";
import { isSharedShellRepoBootstrapTask } from "./thread-contract.js";
import { applyWorkspacePreviewDefaults, inspectWorkspaceBootstrap } from "./workspace-bootstrap.js";

function normalizeLeaseTtlMs(leaseTtlMinutes: unknown): number | null {
  const numeric = typeof leaseTtlMinutes === "number" ? leaseTtlMinutes : Number(leaseTtlMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(60_000, Math.trunc(numeric * 60_000));
}

function resolveStickyFlag(input: { sticky?: boolean; pinned?: boolean }): boolean | undefined {
  if (typeof input.sticky === "boolean") {
    return input.sticky;
  }
  if (typeof input.pinned === "boolean") {
    return input.pinned;
  }
  return undefined;
}

function withRequestedLeaseLifecycle<T extends object>(
  lease: T,
  input: { sticky?: boolean; pinned?: boolean; leaseTtlMinutes?: number }
): T & { pinned?: boolean; leaseTtlMs?: number | null } {
  const pinned = resolveStickyFlag(input);
  const leaseTtlMs = normalizeLeaseTtlMs(input.leaseTtlMinutes);
  return {
    ...lease,
    ...(typeof pinned === "boolean" ? { pinned } : {}),
    ...(leaseTtlMs !== null ? { leaseTtlMs } : {})
  };
}

function formatLeaseLifecycle(lease: {
  pinned?: boolean;
  lifecycleState?: string;
  leaseTtlMs?: number | null;
  expiresAt?: number | null;
} & object): string {
  const state = lease.pinned ? "sticky" : lease.lifecycleState ?? "active";
  const ttlMinutes =
    typeof lease.leaseTtlMs === "number" && Number.isFinite(lease.leaseTtlMs)
      ? Math.max(1, Math.round(lease.leaseTtlMs / 60_000))
      : null;
  const expiry = typeof lease.expiresAt === "number" && Number.isFinite(lease.expiresAt) ? ` expires=${new Date(lease.expiresAt).toISOString()}` : "";
  return `lease=${state}${ttlMinutes ? ` ttl=${ttlMinutes}m` : ""}${expiry}`;
}

export function buildButlerStackPreviewTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    ...buildButlerStackTools(access),
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
                    `${index + 1}. ${lease.title} | thread=${lease.threadId ?? "(none)"} | status=${lease.status}/${lease.bootstrap.phase} | ${formatLeaseLifecycle(lease)} | route=${lease.operatorUrl}`
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
            description: "Previews always copy into an isolated disposable workspace. The shared value is accepted only for compatibility."
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
        ),
        sticky: Type.Optional(
          Type.Boolean({
            description: "Keep this preview lease across automatic cleanup so later jobs can reuse it."
          })
        ),
        leaseTtlMinutes: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Override the cleanup TTL for this preview lease when sticky is false."
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
          sticky?: boolean;
          leaseTtlMinutes?: number;
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

        const lease = withRequestedLeaseLifecycle(await access.runtimeBroker.createLease({
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
          workspaceMode: "snapshot",
          image: previewDefaults.image,
          egressProfile: previewDefaults.egressProfile ?? "internet",
          egressDomains: previewDefaults.egressDomains ?? [],
          bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
          bootstrapHint: previewDefaults.bootstrapHint,
          heartbeatKind: typedParams.heartbeatKind as "none" | "http" | "tcp" | "command" | undefined,
          heartbeatTarget: typedParams.heartbeatTarget,
          heartbeatIntervalSeconds: typedParams.heartbeatIntervalSeconds,
          env: access.normalizeServiceEnv(typedParams.env)
        }), typedParams);
        access.store.upsertPreviewLease(lease);

        return {
          content: [
            {
              type: "text",
              text: `Started preview ${lease.title} at ${lease.operatorUrl}. Workspace=${lease.workspaceMode}. Bootstrap=${lease.bootstrap.phase}${lease.bootstrap.hint ? ` (${lease.bootstrap.hint})` : ""}. ${formatLeaseLifecycle(lease)}.${previewDefaults.autofilled.length > 0 ? ` Auto-filled ${previewDefaults.autofilled.join(", ")} from workspace bootstrap.` : ""}`
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
      name: "set_preview_lease",
      label: "Set preview lease",
      description: "Update a preview lease lifecycle, including sticky reuse and cleanup TTL.",
      promptSnippet:
        "set_preview_lease: use sticky=true when a preview should stay warm for later jobs; use sticky=false or leaseTtlMinutes to return it to normal cleanup.",
      parameters: Type.Object({
        leaseId: Type.String(),
        sticky: Type.Optional(Type.Boolean()),
        leaseTtlMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        refresh: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("set_preview_lease"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string; sticky?: boolean; leaseTtlMinutes?: number; refresh?: boolean };
        const current = access.requireValidatedPreview(typedParams.leaseId, null);
        const lease = access.store.setPreviewLeaseLifecycle(current.id, {
          pinned: resolveStickyFlag(typedParams),
          leaseTtlMs: typedParams.leaseTtlMinutes === undefined ? undefined : normalizeLeaseTtlMs(typedParams.leaseTtlMinutes),
          refresh: typedParams.refresh !== false
        });
        if (!lease) {
          throw new Error(`Unknown preview: ${typedParams.leaseId}`);
        }
        return {
          content: [{ type: "text", text: `Updated preview ${lease.title}. ${formatLeaseLifecycle(lease)}.` }],
          details: { lease }
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
        const inspected = await access.runtimeBroker.inspectLease(typedParams.leaseId);
        access.store.upsertPreviewLease(inspected);
        const lease = access.store.notePreviewLeaseActivity(inspected.id) ?? access.store.getPreviewLease(inspected.id) ?? inspected;
        const domains = lease.egressDomains.length > 0 ? lease.egressDomains.join(", ") : "(none)";
        return {
          content: [
            {
              type: "text",
              text: `${lease.title} is ${inspected.runtime.status}. Bootstrap=${lease.bootstrap.phase}. Workspace=${lease.workspaceMode}. ${formatLeaseLifecycle(lease)}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}. Domains=${domains}.`
            }
          ],
          details: { lease, runtime: inspected.runtime }
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
        resolution: Type.Optional(Type.Union([Type.Literal("1080p"), Type.Literal("2k"), Type.Literal("1440p")])),
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
          resolution?: string;
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
          resolution: typedParams.resolution?.trim() || undefined,
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
        resolution: Type.Optional(Type.Union([Type.Literal("1080p"), Type.Literal("2k"), Type.Literal("1440p")])),
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
          resolution?: string;
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
          resolution: typedParams.resolution?.trim() || undefined,
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
      name: "desktop_proof_status",
      label: "Desktop proof status",
      description: "Check whether the opt-in headed desktop proof sidecar is available.",
      promptSnippet:
        "desktop_proof_status: use this before native Electron proof. If unavailable, ask the operator to enable the desktop profile before claiming native proof is blocked; do not fall back to a private Xvfb display for VNC-visible proof.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("desktop_proof_status"),
      execute: async () => {
        const status = await access.runtimeBroker.getDesktopProofStatus();
        return {
          content: [
            {
              type: "text",
              text: status.available
                ? `Desktop proof sidecar is ready. Active sessions=${status.health?.activeSessionCount ?? 0}.`
                : `Desktop proof sidecar is unavailable. ${status.message}`
            }
          ],
          details: { status }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_desktop_session",
      label: "Start desktop session",
      description: "Start a headed desktop proof session for an Electron or native desktop command.",
      promptSnippet:
        "start_desktop_session: launch Electron/native desktop commands in the shared headed desktop sidecar so they are visible in noVNC. For delegated Codex work, pass that threadId so the runtime anchors to the job and gets a per-thread workspace. Use interactive=true when the operator should keep using it; stop the session to persist screenshots and logs.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        attachedThreadIds: Type.Optional(Type.Array(Type.String())),
        workspaceKey: Type.Optional(Type.String()),
        workspaceName: Type.Optional(Type.String()),
        command: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        interactive: Type.Optional(Type.Boolean()),
        owner: Type.Optional(Type.String()),
        profileKey: Type.Optional(Type.String()),
        waitMs: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      uiEffects: access.getToolUiEffects("start_desktop_session"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId?: string;
          attachedThreadIds?: string[];
          workspaceKey?: string;
          workspaceName?: string;
          command: string;
          title?: string;
          cwd?: string;
          env?: Record<string, string>;
          interactive?: boolean;
          owner?: string;
          profileKey?: string;
          waitMs?: number;
        };
        const threadId = typedParams.threadId?.trim() || null;
        const attachedThreadIds = access.normalizeStringArray(typedParams.attachedThreadIds);
        if (threadId && !attachedThreadIds.includes(threadId)) {
          attachedThreadIds.unshift(threadId);
        }
        const workspaceKey = typedParams.workspaceKey?.trim() || threadId || attachedThreadIds[0] || "desktop";
        const workspaceName = typedParams.workspaceName?.trim() || workspaceKey;
        const thread = threadId ? access.store.getThread(threadId) ?? null : null;
        const cwd = typedParams.cwd?.trim() || thread?.cwd || "";
        const project = access.resolveWorkspaceProject(
          cwd,
          thread?.supervisor.projectId ?? "desktop",
          thread?.supervisor.projectLabel ?? "desktop"
        );
        const session = await access.runtimeBroker.startDesktopSession({
          threadId: threadId ?? "desktop",
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title?.trim() || typedParams.command.trim(),
          command: typedParams.command.trim(),
          cwd: cwd || undefined,
          env: typedParams.env && Object.keys(typedParams.env).length > 0 ? typedParams.env : undefined,
          interactive: Boolean(typedParams.interactive),
          owner: typedParams.owner?.trim() || "agent",
          profileKey: typedParams.profileKey?.trim() || undefined,
          attachedThreadIds,
          workspaceKey,
          workspaceName,
          waitMs:
            typeof typedParams.waitMs === "number" && Number.isFinite(typedParams.waitMs)
              ? Math.max(0, Math.trunc(typedParams.waitMs))
              : undefined
        });
        return {
          content: [
            {
              type: "text",
              text: `Started desktop session ${session.sessionId}. Workspace=${session.workspaceName ?? workspaceName}. Stop it to persist proof.`
            }
          ],
          details: { session }
        };
      }
    }),
    access.defineButlerTool({
      name: "list_desktop_sessions",
      label: "List desktop sessions",
      description: "List active headed desktop sessions visible in noVNC.",
      promptSnippet: "list_desktop_sessions: use this before launching another native desktop app or when the operator asks what desktop session is active. Reuse the shared sidecar and attach the relevant thread instead of creating another sidecar.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("list_desktop_sessions"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { threadId?: string };
        const sessions = await access.runtimeBroker.listDesktopSessions(typedParams.threadId?.trim() || null);
        return {
          content: [
            {
              type: "text",
              text:
                sessions.length === 0
                  ? "No desktop sessions are active."
                  : sessions
                      .map(
                        (session, index) =>
                          `${index + 1}. ${session.title} | session=${session.sessionId} | ${session.running ? "running" : "stopped"} | workspace=${session.workspaceName ?? "(none)"} | attached=${session.attachedThreadIds?.join(",") || "(none)"} | actions=${session.actionCount} | vnc=${session.vncUrl}`
                      )
                      .join("\n")
            }
          ],
          details: { sessions }
        };
      }
    }),
    access.defineButlerTool({
      name: "desktop_session_state",
      label: "Desktop session state",
      description: "Inspect one active headed desktop proof session.",
      promptSnippet: "desktop_session_state: confirm native desktop session health before continuing.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("desktop_session_state"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { sessionId: string };
        const result = await access.runtimeBroker.inspectDesktopSession(typedParams.sessionId.trim());
        return {
          content: [
            {
              type: "text",
              text: `Desktop session ${result.session.sessionId} is ${result.session.running ? "running" : "stopped"}. Actions=${result.session.actionCount}.`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "desktop_current_screen",
      label: "Current desktop screen",
      description: "Capture the current headed desktop screen and return screenshot, window list, pointer, and display geometry.",
      promptSnippet:
        "desktop_current_screen: use this before clicking in a headed desktop session and whenever the operator asks what is visible.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        label: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("desktop_current_screen"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { sessionId: string; label?: string; fileName?: string };
        const result = await access.runtimeBroker.runDesktopSessionAction(typedParams.sessionId.trim(), {
          type: "current_screen",
          actor: "agent",
          label: typedParams.label?.trim() || undefined,
          fileName: typedParams.fileName?.trim() || undefined
        });
        const windowCount =
          result.action.output && typeof result.action.output === "object" && Array.isArray((result.action.output as { windows?: unknown }).windows)
            ? ((result.action.output as { windows: unknown[] }).windows.length)
            : 0;
        return {
          content: [
            {
              type: "text",
              text: `Captured current desktop screen. Windows=${windowCount}. Actions=${result.state.actionCount}.`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "desktop_session_action",
      label: "Desktop session action",
      description: "Run one action in a headed desktop session, such as screenshot, wait, click, drag, key, type, window control, or clipboard control.",
      promptSnippet:
        "desktop_session_action: use screenshot checkpoints, window listing/focus, clipboard, and simple desktop input while native Electron proof is running.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        actionType: Type.String({ minLength: 1 }),
        actor: Type.Optional(Type.String()),
        force: Type.Optional(Type.Boolean()),
        label: Type.Optional(Type.String()),
        fileName: Type.Optional(Type.String()),
        ms: Type.Optional(Type.Number({ minimum: 0 })),
        ttlMs: Type.Optional(Type.Number({ minimum: 0 })),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        toX: Type.Optional(Type.Number()),
        toY: Type.Optional(Type.Number()),
        button: Type.Optional(Type.Number({ minimum: 1 })),
        windowId: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        targetText: Type.Optional(Type.String()),
        matchMode: Type.Optional(Type.Union([Type.Literal("contains"), Type.Literal("exact")])),
        cdpUrl: Type.Optional(Type.String()),
        cdpPort: Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
        delayMs: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      uiEffects: access.getToolUiEffects("desktop_session_action"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          sessionId: string;
          actionType: string;
          actor?: string;
          force?: boolean;
          label?: string;
          fileName?: string;
          ms?: number;
          ttlMs?: number;
          x?: number;
          y?: number;
          toX?: number;
          toY?: number;
          button?: number;
          windowId?: string;
          key?: string;
          text?: string;
          targetText?: string;
          matchMode?: "contains" | "exact";
          cdpUrl?: string;
          cdpPort?: number;
          delayMs?: number;
        };
        const result = await access.runtimeBroker.runDesktopSessionAction(typedParams.sessionId.trim(), {
          type: typedParams.actionType.trim(),
          actor: typedParams.actor?.trim() || "agent",
          force: Boolean(typedParams.force),
          label: typedParams.label?.trim() || undefined,
          fileName: typedParams.fileName?.trim() || undefined,
          ms:
            typeof typedParams.ms === "number" && Number.isFinite(typedParams.ms)
              ? Math.max(0, Math.trunc(typedParams.ms))
              : undefined,
          ttlMs:
            typeof typedParams.ttlMs === "number" && Number.isFinite(typedParams.ttlMs)
              ? Math.max(0, Math.trunc(typedParams.ttlMs))
              : undefined,
          x: typeof typedParams.x === "number" && Number.isFinite(typedParams.x) ? typedParams.x : undefined,
          y: typeof typedParams.y === "number" && Number.isFinite(typedParams.y) ? typedParams.y : undefined,
          toX: typeof typedParams.toX === "number" && Number.isFinite(typedParams.toX) ? typedParams.toX : undefined,
          toY: typeof typedParams.toY === "number" && Number.isFinite(typedParams.toY) ? typedParams.toY : undefined,
          button:
            typeof typedParams.button === "number" && Number.isFinite(typedParams.button)
              ? Math.max(1, Math.trunc(typedParams.button))
              : undefined,
          windowId: typedParams.windowId?.trim() || undefined,
          key: typedParams.key?.trim() || undefined,
          text: typedParams.text || undefined,
          targetText: typedParams.targetText?.trim() || undefined,
          matchMode: typedParams.matchMode,
          cdpUrl: typedParams.cdpUrl?.trim() || undefined,
          cdpPort:
            typeof typedParams.cdpPort === "number" && Number.isFinite(typedParams.cdpPort)
              ? Math.max(1, Math.trunc(typedParams.cdpPort))
              : undefined,
          delayMs:
            typeof typedParams.delayMs === "number" && Number.isFinite(typedParams.delayMs)
              ? Math.max(0, Math.trunc(typedParams.delayMs))
              : undefined
        });
        return {
          content: [
            {
              type: "text",
              text: `Desktop action ${result.action.type} completed. Actions=${result.state.actionCount}.`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_desktop_session",
      label: "Stop desktop session",
      description: "Stop a headed desktop proof session and persist screenshots and logs.",
      promptSnippet:
        "stop_desktop_session: finalize native desktop proof. This saves desktop screenshots and command logs.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        reason: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("stop_desktop_session"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          sessionId: string;
          reason?: string;
        };
        const result = await access.runtimeBroker.stopDesktopSession(
          typedParams.sessionId.trim(),
          typedParams.reason?.trim() || undefined
        );
        const verification = decoratePreviewVerification(result.verification);
        if (result.desktopProof) {
          access.store.recordBrowserVerification({
            threadId: result.desktopProof.threadId,
            projectId: result.desktopProof.projectId,
            projectLabel: result.desktopProof.projectLabel,
            title: result.desktopProof.title,
            verification
          });
        }
        const screenshots = verification.artifacts.filter((artifact) => artifact.kind === "screenshot");
        const remediationHint = verification.failureKind !== "none" ? verification.diagnostics?.remediationHints?.[0] ?? "" : "";
        return {
          content: [
            {
              type: "text",
              text: `Stopped desktop session with proof run ${verification.runId}. Saved ${screenshots.length} screenshots. ${verification.failureKind === "none" ? "Signals=none." : `Signals=${verification.failureKind}.${remediationHint ? ` Hint=${remediationHint}.` : ""}`}`
            }
          ],
          details: {
            verification,
            screenshots,
            desktopProof: result.desktopProof ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "review_preview_proof",
      label: "Review proof",
      description: "Inspect the latest proof bundle for one preview or job and decide whether the recorded artifacts are convincing.",
      promptSnippet:
        "review_preview_proof: use this when proof is demanded. It can review browser, desktop, and file proof bundles. For UI-impacting work, screenshot or video proof must show the relevant state.",
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

        const availableArtifactCount = proof.artifacts.length;
        const proofVerdict = availableArtifactCount > 0 ? review.verdict : "incomplete";
        const artifactSummary =
          availableArtifactCount > 0
            ? `${availableArtifactCount} available (${proof.artifacts
                .slice(0, 3)
                .map((artifact) => `${artifact.kind}:${artifact.label}`)
                .join(", ")}${availableArtifactCount > 3 ? ", ..." : ""})`
            : "none";
        const proofSummary = [
          `Verdict=${proofVerdict}`,
          `FailureKind=${proof.verification.failureKind}`,
          `Visible=${review.visibleState}`,
          `Evidence=${review.evidence}`,
          `Concern=${availableArtifactCount > 0 ? review.concern : "Recorded proof artifacts are missing."}`,
          `RecordedVideo=${proof.video ? "yes" : "no"}`,
          `Artifacts=${artifactSummary}`
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
            artifacts: proof.artifacts,
            screenshots: proof.screenshots,
            screenshot: proof.primaryScreenshot,
            primaryArtifact: proof.primaryArtifact,
            video: proof.video,
            manifest: proof.manifest,
            trace: proof.trace,
            review,
            proofComplete: availableArtifactCount > 0
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
      description: "Run one command or argv-style process inside a preview isolate through the runtime broker, with optional stdin.",
      promptSnippet:
        "exec_preview: use this when Butler needs to inspect, smoke test, run code, or patch a preview isolate directly. Prefer commandArgs for exact argv execution; use command for shell snippets; set stdinProvided when sending stdin.",
      parameters: Type.Object({
        leaseId: Type.String(),
        command: Type.Optional(Type.String({ minLength: 1 })),
        commandArgs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        cwd: Type.Optional(Type.String()),
        stdin: Type.Optional(Type.String()),
        stdinProvided: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("exec_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          leaseId: string;
          command?: string;
          commandArgs?: string[];
          cwd?: string;
          stdin?: string;
          stdinProvided?: boolean;
        };
        const command = typedParams.command?.trim() ?? "";
        const commandArgs = Array.isArray(typedParams.commandArgs)
          ? typedParams.commandArgs.map((entry) => entry.trim()).filter(Boolean)
          : [];
        if (!command && commandArgs.length === 0) {
          throw new Error("exec_preview requires command or commandArgs");
        }
        const result = await access.runtimeBroker.execInLease({
          leaseId: typedParams.leaseId,
          command,
          commandArgs,
          cwd: typedParams.cwd?.trim() || undefined,
          stdin: typedParams.stdin,
          stdinProvided: typedParams.stdinProvided === true || typeof typedParams.stdin === "string"
        });
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
      description:
        "Start a new Codex workstream for execution such as repo cloning, project setup, coding work, shell work, file generation, app building, or command execution. Optionally choose the Codex thinking budget for the delegated turn.",
      promptSnippet:
        "delegate_to_codex: start new execution, coding, shell work, repo setup, app build, file generation, or other task delivery by Codex. Budget policy: use low for most execution/coding; medium for extra agency, planning, ambiguity, or product judgment; high for tough issues after medium underperforms or clearly hard incidents; xhigh is exceptional and under 1% usage.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        goal: Type.Optional(Type.String({ minLength: 1 })),
        cwd: Type.Optional(Type.String()),
        thinkingBudget: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh")
        ])),
        imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        fileReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
      }),
      uiEffects: access.getToolUiEffects("delegate_to_codex"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          task: string;
          goal?: string;
          cwd?: string;
          thinkingBudget?: ReasoningEffort;
          imageReferenceIds?: string[];
          fileReferenceIds?: string[];
        };
        const workspace = await access.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
        const delegatedTask = typedParams.task;
        const delegatedGoal = typedParams.goal;
        const repoBootstrapTask = isSharedShellRepoBootstrapTask(delegatedTask);
        const developerInstructions = await access.buildDelegationDeveloperInstructions(workspace, delegatedTask);
        const extraNotes = repoBootstrapTask
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
          effort: typedParams.thinkingBudget ?? null,
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
          `Accepted. I delegated this to Codex in job ${result.threadId} and will return here with the result.`
        );
        access.registerPendingChatCallback(result.threadId);
        const supervision = access.store.noteButlerSteer(result.threadId);

        return {
          content: [
            {
              type: "text",
              text: `Delegated the task to Codex in job ${result.threadId} from ${workspace.cwd}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
            }
          ],
          details: {
            threadId: result.threadId,
            thinkingBudget: typedParams.thinkingBudget ?? null,
            supervision,
            workspace,
            thread: access.store.getThread(result.threadId) ?? null
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "run_supervision_smoke_test",
      label: "Run supervision smoke test",
      description:
        "Start a synthetic Codex job that exists only to verify Butler can privately steer a worker through supervisor callbacks.",
      promptSnippet:
        "run_supervision_smoke_test: intentionally test Butler's own supervision loop. Use only when you decide the operator is asking to verify Butler supervision itself, not for ordinary implementation tasks that need tests or smoke verification.",
      parameters: Type.Object({
        totalFollowUps: Type.Optional(Type.Union([
          Type.Literal(2),
          Type.Literal(3),
          Type.Literal(4),
          Type.Literal(5)
        ])),
        thinkingBudget: Type.Optional(Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh")
        ]))
      }),
      uiEffects: access.getToolUiEffects("run_supervision_smoke_test"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          totalFollowUps?: 2 | 3 | 4 | 5;
          thinkingBudget?: ReasoningEffort;
        };
        const totalFollowUps = typedParams.totalFollowUps ?? 3;
        const workspace = { cwd: "/repos", branchName: null as string | null };
        const delegatedTask = access.buildSupervisionSmokeTask(totalFollowUps);
        const developerInstructions = await access.buildDelegationDeveloperInstructions(workspace, delegatedTask);
        const extraNotes = ["Synthetic Butler supervision smoke test. Do not gather proof unless the smoke test explicitly asks for it."];

        const result = await access.codexClient.startThread({
          task: delegatedTask,
          input: async (threadId: string) =>
            buildCodexInputWithReferences({
              text: (
                await access.buildDelegationContract({
                  threadId,
                  task: delegatedTask,
                  workspace,
                  extraNotes
                })
              ).text,
              imageStore: access.imageStore,
              imageReferenceIds: [],
              fileStore: access.fileStore,
              fileReferenceIds: []
            }),
          cwd: workspace.cwd,
          developerInstructions,
          effort: typedParams.thinkingBudget ?? null,
          openWindow: true
        });
        const delegationContract = await access.buildDelegationContract({
          threadId: result.threadId,
          task: delegatedTask,
          workspace,
          extraNotes
        });
        access.store.setThreadExecutionContract(result.threadId, delegationContract.contract);
        access.store.addEvent(result.threadId, "butler.delegation.created", "Butler created a synthetic supervision smoke job.");
        access.noteThreadFocus(result.threadId, "run_supervision_smoke_test");
        access.queueDelegationAcknowledgement(
          result.threadId,
          `Accepted. I started a supervision smoke test in job ${result.threadId}. I will return here when it completes.`
        );
        access.registerPendingChatCallback(result.threadId);
        access.store.setThreadSupervisionLimit(result.threadId, totalFollowUps + 2);
        access.supervisionSmokePlans.set(result.threadId, {
          threadId: result.threadId,
          totalFollowUps,
          followUpsSent: 0
        });
        const supervision = access.store.noteButlerSteer(result.threadId);

        return {
          content: [
            {
              type: "text",
              text: `Started supervision smoke test in job ${result.threadId}. Butler will privately steer ${totalFollowUps} follow-up turns. Budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
            }
          ],
          details: {
            threadId: result.threadId,
            totalFollowUps,
            thinkingBudget: typedParams.thinkingBudget ?? null,
            supervision,
            workspace,
            thread: access.store.getThread(result.threadId) ?? null
          }
        };
      }
    })
  ];
}
