import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import { decoratePreviewVerification } from "./preview-verification.js";
import { buildWorkerInputWithReferences } from "./reference-inputs.js";
import { formatPreviewRuntimeDiagnostics } from "./runtime-broker-client.js";
import { formatPreviewBootstrapHistory } from "./codex-harness-preview-lifecycle.js";
import { observeStartedPreview } from "./butler-preview-bootstrap-observer.js";
import { buildButlerStackTools } from "./butler-agent-stack-tools.js";
import { normalizeBrowserSessionCookies } from "./butler-browser-tool-input.js";
import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { reviewPreviewProofSchema, startPreviewSchema, stringEnumSchema, stringMapSchema } from "./butler-agent-tool-schemas.js";
import { formatButlerToolOutput } from "./butler-tool-output.js";
import {
  assertRuntimeAttachedThreadsOwned,
  assertRuntimeResourceOwned,
  getRuntimeOwnerThreadIds,
  getRuntimeStartThreadId,
  isRuntimeResourceOwned
} from "./butler-runtime-tool-ownership.js";
import {
  formatLeaseLifecycle,
  normalizeLeaseTtlMs,
  requireCaptureMetadata,
  resolveStickyFlag,
  withRequestedLeaseLifecycle
} from "./butler-runtime-lease-tool-helpers.js";
import type { PreviewProofReviewView, ReasoningEffort } from "./types.js";
import { buildDelegationRoutingDecision } from "./butler-delegation-routing.js";
import { continueAttachedWorkerDelegation } from "./butler-attached-worker-delegation.js";
import { assertCallbackReviewCurrent } from "./butler-job-mutation-guard.js";
import { isSharedShellRepoBootstrapTask } from "./thread-contract.js";
import { applyWorkspacePreviewDefaults, inspectWorkspaceBootstrap } from "./workspace-bootstrap.js";
import type { ButlerRoutingDecisionView } from "./types.js";
import { taskRequiresManagedWorktree } from "./repo-worktree.js";
import { deleteWorkerThread, startWorkerThread, stopWorkerThread } from "./worker-client-router.js";
import { workerHarnessLabel, workerProviderModelRoute } from "./butler-worker-tool-format.js";
export { workerProviderModelRoute } from "./butler-worker-tool-format.js";

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
        const leases = access.store.listPreviewLeases().filter((lease) => isRuntimeResourceOwned(access, lease));
        const summary =
          leases.length === 0
            ? "No preview leases are active."
            : leases
                .map(
                  (lease, index) =>
                    `${index + 1}. ${lease.title} | id=${lease.id} | thread=${lease.threadId ?? "(none)"} | status=${lease.status}/${lease.bootstrap.phase} | ${formatLeaseLifecycle(lease)} | route=${lease.operatorUrl}`
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
      promptSnippet: "start_preview: use this only for work Butler is handling directly when a live reviewable app is needed. Preview user directories are writable automatically. If OS packages are required, pass imageSetupCommand; Manor prepares the image separately and still runs the preview non-root. If the operator explicitly asked for delegation or Worker, call delegate_to_worker instead.",
      parameters: startPreviewSchema(),
      uiEffects: access.getToolUiEffects("start_preview"),
      execute: async (_toolCallId, params, signal) => {
        const typedParams = params as {
          threadId?: string;
          cwd: string;
          title: string;
          command: string;
          port: number;
          stackId?: string;
          aliases?: string[];
          env?: Record<string, string>;
          image?: string;
          imageSetupCommand?: string;
          egressProfile?: string;
          egressDomains?: string[];
          bootstrapWaitSeconds?: number;
          bootstrapHint?: string;
          heartbeatKind?: "none" | "http" | "tcp" | "command";
          heartbeatTarget?: string;
          heartbeatIntervalSeconds?: number;
          sticky?: boolean;
          leaseTtlMinutes?: number;
        };

        const threadId = getRuntimeStartThreadId(access, typedParams.threadId, "start_preview");
        const thread = access.store.getThread(threadId) ?? null;
        const stack = access.getValidatedStack(typedParams.stackId?.trim() || null, null);
        if (stack) assertRuntimeResourceOwned(access, stack, `Stack ${stack.id}`);
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

        let lease = withRequestedLeaseLifecycle(await access.runtimeBroker.createLease({
          leaseId,
          threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title,
          stackId: stack?.id ?? null,
          aliases: access.normalizeStringArray(typedParams.aliases),
          worktreePath,
          branchName: thread && worktreePath === thread.cwd ? thread.executionContract?.branch ?? null : null,
          targetPort: typedParams.port,
          command: typedParams.command,
          workspaceMode: "snapshot",
          image: previewDefaults.image,
          imageSetupCommand: typedParams.imageSetupCommand,
          egressProfile: previewDefaults.egressProfile ?? "internet",
          egressDomains: previewDefaults.egressDomains ?? [],
          bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
          bootstrapHint: previewDefaults.bootstrapHint,
          heartbeatKind: typedParams.heartbeatKind,
          heartbeatTarget: typedParams.heartbeatTarget,
          heartbeatIntervalSeconds: typedParams.heartbeatIntervalSeconds,
          env: access.normalizeServiceEnv(typedParams.env)
        }), typedParams);
        access.store.upsertPreviewLease(lease);

        const observation = await observeStartedPreview({
          access,
          lease,
          lifecycle: typedParams,
          bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
          signal
        });
        lease = observation.lease;
        if (observation.pending) {
          const heartbeat = lease.bootstrap.lastHeartbeatError ? ` Last bootstrap signal: ${lease.bootstrap.lastHeartbeatError}.` : "";
          return {
            content: [
              {
                type: "text",
                text: `Preview ${lease.title} is still starting at ${lease.operatorUrl}. Bootstrap=${lease.bootstrap.phase}.${heartbeat} Use inspect_preview with lease id ${lease.id} for the terminal result.\n${formatPreviewBootstrapHistory(lease)}`
              }
            ],
            details: { lease, runtime: observation.runtime, pending: true, workspaceBootstrap, previewDefaults }
          };
        }

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
        leaseId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("stop_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        const preview = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        const cached = access.store.getPreviewLease(preview.id);
        if (!cached) throw new Error(`Preview ${preview.id} is not present in cached runtime state.`);
        access.store.markPreviewLeaseStopping(preview.id);
        try {
          await access.runtimeBroker.stopLease(preview.id);
        } catch (error) {
          access.store.upsertPreviewLease(cached);
          throw error;
        }
        access.store.removePreviewLease(preview.id);
        return {
          content: [{ type: "text", text: `Stopped preview ${preview.id}.` }],
          details: { leaseId: preview.id }
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
        leaseId: Type.String({ minLength: 1 }),
        sticky: Type.Optional(Type.Boolean()),
        leaseTtlMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        refresh: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("set_preview_lease"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string; sticky?: boolean; leaseTtlMinutes?: number; refresh?: boolean };
        const current = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, current, `Preview ${current.id}`);
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
        leaseId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("inspect_preview"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        const selected = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, selected, `Preview ${selected.id}`);
        const inspected = await access.runtimeBroker.inspectLease(selected.id);
        assertRuntimeResourceOwned(access, inspected, `Preview ${inspected.id}`);
        access.store.upsertPreviewLease(inspected);
        const lease = access.store.notePreviewLeaseActivity(inspected.id) ?? access.store.getPreviewLease(inspected.id) ?? inspected;
        const domains = lease.egressDomains.length > 0 ? lease.egressDomains.join(", ") : "(none)";
        const runtimeSummary = inspected.runtime.running
          ? `runtimeStatus=${inspected.runtime.status}`
          : formatPreviewRuntimeDiagnostics(inspected.runtime);
        return {
          content: [
            {
              type: "text",
              text: `${lease.title} is ${lease.status}. ${runtimeSummary}. Bootstrap=${lease.bootstrap.phase}. Workspace=${lease.workspaceMode}. ${formatLeaseLifecycle(lease)}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}. Domains=${domains}.\n${formatPreviewBootstrapHistory(lease)}`
            }
          ],
          details: { lease, runtime: inspected.runtime }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_preview_browser_session",
      label: "Start preview browser session",
      description: "Attach a browser sidecar to one preview and begin a live recorded session. Initial page content passes through Content Admission Review and may be warned or withheld.",
      promptSnippet:
        "start_preview_browser_session: open a live browser session only for preview work Butler is handling directly. If the operator explicitly asked for delegation or Worker, call delegate_to_worker instead. The timer and recording begin immediately; stop the session later to persist proof.",
      parameters: Type.Object({
        leaseId: Type.String({ minLength: 1 }),
        mode: Type.Optional(stringEnumSchema(["headless", "headful"] as const)),
        resolution: Type.Optional(stringEnumSchema(["1080p", "2k", "1440p"] as const)),
        path: Type.Optional(Type.String()),
        targetUrl: Type.Optional(Type.String()),
        waitForSelector: Type.Optional(Type.String()),
        postLoadWaitMs: Type.Optional(Type.Number({ minimum: 0 })),
        headers: Type.Optional(stringMapSchema()),
        cookies: Type.Optional(stringMapSchema()),
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
        assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        const cookies = normalizeBrowserSessionCookies(typedParams.cookies, typedParams.sessionCookie);
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
          cookies: cookies.length > 0 ? cookies : undefined
        });
        access.store.notePreviewLeaseActivity(preview.id);

        return {
          content: [
            {
              type: "text",
              text: `Started browser session ${session.sessionId} for ${preview.title}. Recording is live until the session is stopped.${session.contentAdmissionNotice ? `\n${session.contentAdmissionNotice}` : ""}`
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
      description: "Start a live recorded browser session for a direct URL. Initial page content passes through Content Admission Review and may be warned or withheld.",
      promptSnippet:
        "start_browser_session: open a live browser session only for work Butler is handling directly. If the operator explicitly asked for delegation or Worker, call delegate_to_worker instead. Proof is persisted only after stop_browser_session.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        targetUrl: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        mode: Type.Optional(stringEnumSchema(["headless", "headful"] as const)),
        resolution: Type.Optional(stringEnumSchema(["1080p", "2k", "1440p"] as const)),
        headers: Type.Optional(stringMapSchema()),
        cookies: Type.Optional(stringMapSchema()),
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
        const threadId = getRuntimeStartThreadId(access, typedParams.threadId, "start_browser_session");
        const thread = access.store.getThread(threadId) ?? null;
        const cwd = thread?.cwd || "";
        const project = access.resolveWorkspaceProject(
          cwd,
          thread?.supervisor.projectId ?? "browser",
          thread?.supervisor.projectLabel ?? "browser"
        );
        const cookies = normalizeBrowserSessionCookies(typedParams.cookies, typedParams.sessionCookie);
        const session = await access.runtimeBroker.startBrowserSession({
          threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title?.trim() || typedParams.targetUrl.trim(),
          targetUrl: typedParams.targetUrl.trim(),
          mode: typedParams.mode === "headful" ? "headful" : "headless",
          resolution: typedParams.resolution?.trim() || undefined,
          headers: typedParams.headers && Object.keys(typedParams.headers).length > 0 ? typedParams.headers : undefined,
          cookies: cookies.length > 0 ? cookies : undefined,
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
              text: `Started browser session ${session.sessionId}. Recording is live until the session is stopped.${session.contentAdmissionNotice ? `\n${session.contentAdmissionNotice}` : ""}`
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
      description: "Inspect one active browser session state. Visible content passes through Content Admission Review and may be warned or withheld.",
      promptSnippet: "browser_session_state: use this to confirm session health, URL, and action count before continuing.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("browser_session_state"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { sessionId: string };
        const result = await access.runtimeBroker.inspectBrowserSession(typedParams.sessionId.trim());
        assertRuntimeResourceOwned(access, result.tracked, `Browser session ${typedParams.sessionId.trim()}`);
        return {
          content: [
            {
              type: "text",
              text: `Session ${result.session.sessionId} is active at ${result.session.url}. Actions=${result.session.actionCount}.${result.session.contentAdmissionNotice ? `\n${result.session.contentAdmissionNotice}` : ""}`
            }
          ],
          details: result
        };
      }
    }),
    access.defineButlerTool({
      name: "browser_session_action",
      label: "Browser session action",
      description: "Run one explicit action in an active browser session, including manual screenshots. Visible page and action output pass through Content Admission Review and may be warned or withheld. Evaluate runs an async Node body with Playwright page/context/browser/chromium and read-only session; read DOM through page.evaluate.",
      promptSnippet:
        "browser_session_action: use this for stepwise browser control. Always provide a specific evidence label and .png fileName; set autoCapture=false only when no screenshot should be stored.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        actionType: stringEnumSchema([
          "click",
          "fill",
          "type",
          "press",
          "hover",
          "select",
          "check",
          "uncheck",
          "scroll",
          "wait_for",
          "navigate",
          "evaluate",
          "screenshot"
        ] as const),
        selector: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        values: Type.Optional(Type.Array(Type.String())),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        urlIncludes: Type.Optional(Type.String()),
        script: Type.Optional(Type.String({ description: "Async Node body for evaluate. Use Playwright page methods and read DOM through page.evaluate." })),
        ms: Type.Optional(Type.Number({ minimum: 0 })),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        delayMs: Type.Optional(Type.Number({ minimum: 0 })),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
        label: Type.String({ minLength: 1, description: "Evidence label for this action." }),
        fileName: Type.String({ minLength: 1, pattern: "^[^/\\\\]+\\.[pP][nN][gG]$", description: "Evidence screenshot file name for this action." }),
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
          label: string;
          fileName: string;
          autoCapture?: boolean;
        };

        requireCaptureMetadata(typedParams.label, typedParams.fileName, `Browser ${typedParams.actionType} action`);
        const sessionState = await access.runtimeBroker.inspectBrowserSession(typedParams.sessionId.trim(), { consumeContentAdmissionNotice: false });
        assertRuntimeResourceOwned(access, sessionState.tracked, `Browser session ${typedParams.sessionId.trim()}`);
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
        const output = formatButlerToolOutput(result.action.output);

        return {
          content: [
            {
              type: "text",
              text: `Browser action ${result.action.type} completed. URL=${result.state.url}. Actions=${result.state.actionCount}.${output ? `\nOutput:\n${output}` : ""}`
            }
          ],
          details: {
            ...result,
            action: { ...result.action, output: output || null }
          }
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

        const sessionState = await access.runtimeBroker.inspectBrowserSession(typedParams.sessionId.trim(), { consumeContentAdmissionNotice: false });
        assertRuntimeResourceOwned(access, sessionState.tracked, `Browser session ${typedParams.sessionId.trim()}`);
        const requestedLeaseId = typedParams.leaseId?.trim() || null;
        if (requestedLeaseId) {
          const preview = access.requireValidatedPreview(requestedLeaseId, null);
          assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
          if (sessionState.tracked?.kind !== "preview" || sessionState.tracked.leaseId !== preview.id) {
            throw new Error(`Browser session ${typedParams.sessionId.trim()} is not attached to preview ${preview.id}.`);
          }
        }

        const result = await access.runtimeBroker.stopBrowserSession(
          typedParams.sessionId.trim(),
          typedParams.reason?.trim() || undefined
        );
        assertRuntimeResourceOwned(access, result.tracked, `Browser session ${typedParams.sessionId.trim()}`);
        if (
          requestedLeaseId &&
          (result.tracked?.kind !== "preview" || result.tracked.leaseId !== requestedLeaseId)
        ) {
          throw new Error(`Stopped browser session did not belong to preview ${requestedLeaseId}.`);
        }
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
            requestedLeaseId || (result.tracked?.kind === "preview" ? result.tracked.leaseId : null);
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
        "start_desktop_session: launch Electron/native desktop commands in the shared headed desktop sidecar so they are visible in noVNC. For delegated Worker jobs, pass that threadId so the runtime anchors to the job and gets a per-thread workspace. Use interactive=true when the operator should keep using it; stop the session to persist screenshots and logs.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        attachedThreadIds: Type.Optional(Type.Array(Type.String())),
        workspaceKey: Type.Optional(Type.String()),
        workspaceName: Type.Optional(Type.String()),
        command: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        env: Type.Optional(stringMapSchema()),
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
        const threadId = getRuntimeStartThreadId(access, typedParams.threadId, "start_desktop_session");
        assertRuntimeAttachedThreadsOwned(access, typedParams.attachedThreadIds, "start_desktop_session");
        const attachedThreadIds = access.normalizeStringArray(typedParams.attachedThreadIds);
        if (threadId && !attachedThreadIds.includes(threadId)) {
          attachedThreadIds.unshift(threadId);
        }
        const workspaceKey = typedParams.workspaceKey?.trim() || threadId || attachedThreadIds[0] || "desktop";
        const workspaceName = typedParams.workspaceName?.trim() || workspaceKey;
        const thread = access.store.getThread(threadId) ?? null;
        const cwd = typedParams.cwd?.trim() || thread?.cwd || "";
        const project = access.resolveWorkspaceProject(
          cwd,
          thread?.supervisor.projectId ?? "desktop",
          thread?.supervisor.projectLabel ?? "desktop"
        );
        const session = await access.runtimeBroker.startDesktopSession({
          threadId,
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
        if (typedParams.threadId) getRuntimeStartThreadId(access, typedParams.threadId, "list_desktop_sessions");
        const sessions = (await access.runtimeBroker.listDesktopSessions(null)).filter((session) =>
          isRuntimeResourceOwned(access, session.tracked)
        );
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
        assertRuntimeResourceOwned(access, result.tracked, `Desktop session ${typedParams.sessionId.trim()}`);
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
        "desktop_current_screen: use this before clicking in a headed desktop session and whenever the operator asks what is visible. Provide a specific label and .png fileName chosen for that evidence.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
        fileName: Type.String({ minLength: 1, pattern: "^[^/\\\\]+\\.[pP][nN][gG]$" })
      }),
      uiEffects: access.getToolUiEffects("desktop_current_screen"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { sessionId: string; label: string; fileName: string };
        const sessionState = await access.runtimeBroker.inspectDesktopSession(typedParams.sessionId.trim());
        assertRuntimeResourceOwned(access, sessionState.tracked, `Desktop session ${typedParams.sessionId.trim()}`);
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
        const output = formatButlerToolOutput(result.action.output);
        return {
          content: [
            {
              type: "text",
              text: `Captured current desktop screen. Windows=${windowCount}. Actions=${result.state.actionCount}.${output ? `\nOutput:\n${output}` : ""}`
            }
          ],
          details: {
            ...result,
            action: { ...result.action, output: output || null }
          }
        };
      }
    }),
    access.defineButlerTool({
      name: "desktop_session_action",
      label: "Desktop session action",
      description: "Run one action in a headed desktop session, such as screenshot, wait, click, drag, key, type, window control, or clipboard control.",
      promptSnippet:
        "desktop_session_action: use screenshot checkpoints, window listing/focus, clipboard, and simple desktop input while native Electron proof is running. Always provide a specific evidence label and .png fileName.",
      parameters: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
        actionType: stringEnumSchema([
          "lock",
          "unlock",
          "screenshot",
          "current_screen",
          "calibrate",
          "wait",
          "click",
          "click_text",
          "drag",
          "key",
          "type",
          "window_list",
          "focus_window",
          "close_window",
          "clipboard_set",
          "clipboard_get",
          "cdp_targets",
          "cdp_accessibility"
        ] as const),
        actor: Type.Optional(Type.String()),
        force: Type.Optional(Type.Boolean()),
        label: Type.String({ minLength: 1, description: "Evidence label for this action." }),
        fileName: Type.String({ minLength: 1, pattern: "^[^/\\\\]+\\.[pP][nN][gG]$", description: "Evidence screenshot file name for this action." }),
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
        matchMode: Type.Optional(stringEnumSchema(["contains", "exact"] as const)),
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
          label: string;
          fileName: string;
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
        requireCaptureMetadata(typedParams.label, typedParams.fileName, `Desktop ${typedParams.actionType} action`);
        const sessionState = await access.runtimeBroker.inspectDesktopSession(typedParams.sessionId.trim());
        assertRuntimeResourceOwned(access, sessionState.tracked, `Desktop session ${typedParams.sessionId.trim()}`);
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
        const output = formatButlerToolOutput(result.action.output);
        return {
          content: [
            {
              type: "text",
              text: `Desktop action ${result.action.type} completed. Actions=${result.state.actionCount}.${output ? `\nOutput:\n${output}` : ""}`
            }
          ],
          details: {
            ...result,
            action: { ...result.action, output: output || null }
          }
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
        const sessionState = await access.runtimeBroker.inspectDesktopSession(typedParams.sessionId.trim());
        assertRuntimeResourceOwned(access, sessionState.tracked, `Desktop session ${typedParams.sessionId.trim()}`);
        const result = await access.runtimeBroker.stopDesktopSession(
          typedParams.sessionId.trim(),
          typedParams.reason?.trim() || undefined
        );
        assertRuntimeResourceOwned(access, result.tracked, `Desktop session ${typedParams.sessionId.trim()}`);
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
      description: "Inspect one exact proof run and decide whether its recorded artifacts are convincing. A thread with several runs returns coverage first so Butler can choose an exact run without repeating vision review.",
      promptSnippet:
        "review_preview_proof: review each unreviewed exact run once, then reuse that verdict across related checklist points. Never pass runId=latest. For UI-impacting work, screenshot or video proof must show the relevant state.",
      parameters: reviewPreviewProofSchema(),
      uiEffects: access.getToolUiEffects("review_preview_proof"),
      execute: async (_toolCallId, params, signal?: AbortSignal) => {
        const typedParams = params as {
          leaseId?: string;
          threadId?: string;
          runId?: string;
          expectedOutcome?: string;
        };

        if (!typedParams.leaseId?.trim() && !typedParams.threadId?.trim() && !typedParams.runId?.trim()) {
          throw new Error("review_preview_proof requires a leaseId or threadId selector.");
        }
        if (typedParams.runId?.trim() && !typedParams.leaseId?.trim() && !typedParams.threadId?.trim()) {
          throw new Error("An exact runId must be scoped by leaseId or threadId.");
        }

        if (typedParams.leaseId) {
          const preview = access.requireValidatedPreview(typedParams.leaseId.trim(), null);
          assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        }
        if (typedParams.threadId) {
          const threadId = typedParams.threadId.trim();
          if (!getRuntimeOwnerThreadIds(access).includes(threadId)) {
            throw new Error(`Proof for job ${threadId} belongs to another Butler session.`);
          }
        }
        if (typedParams.runId?.trim().toLowerCase() === "latest") {
          throw new Error("review_preview_proof requires an exact runId. Use threadId without runId to list available proof coverage.");
        }
        if (typedParams.threadId && !typedParams.runId && !typedParams.leaseId) {
          const threadProofs = access.store.listPreviewProofs()
            .filter((entry) => entry.threadId === typedParams.threadId!.trim())
            .sort((left, right) => right.updatedAt - left.updatedAt);
          if (threadProofs.length > 1) {
            const coverage = threadProofs.map((entry) => {
              const latestReview = entry.proofReviews.at(-1);
              return `${entry.verification.runId}: verification=${entry.verification.ok && entry.verification.failureKind === "none" ? "passed" : `failed:${entry.verification.failureKind}`} | review=${latestReview?.verdict ?? "unreviewed"} | title=${entry.previewTitle}`;
            });
            return {
              content: [{ type: "text", text: `Multiple proof runs exist for this job. Reuse credible verdicts and call review_preview_proof only for an exact unreviewed or unclear runId.\n${coverage.join("\n")}` }],
              details: { proofCoverage: threadProofs, requiresExactRunId: true }
            };
          }
        }

        const proof = access.resolvePreviewProof({
          leaseId: typedParams.leaseId?.trim(),
          threadId: typedParams.threadId?.trim(),
          runId: typedParams.runId?.trim()
        });
        assertRuntimeResourceOwned(access, proof.preview, `Proof run ${proof.verification.runId}`);
        const review = await access.reviewProofScreenshot(proof, {
          expectedOutcome: typedParams.expectedOutcome,
          signal
        });
        const deterministicFailure = !proof.verification.ok || proof.verification.failureKind !== "none";
        const reviewVerdict = deterministicFailure ? "failed" as const : review.verdict;
        const reviewConcern = deterministicFailure
          ? proof.verification.error ?? `Recorded proof failed with signal ${proof.verification.failureKind}.`
          : review.concern;
        if (typedParams.threadId) assertCallbackReviewCurrent(typedParams.threadId);
        let persistedProofReview: PreviewProofReviewView | null = null;
        if (proof.proofRecordId) {
          const reviewRecord: PreviewProofReviewView = {
            id: crypto.randomUUID(),
            verdict: reviewVerdict === "credible" || reviewVerdict === "failed" ? reviewVerdict : "unclear",
            visibleState: review.visibleState,
            evidence: review.evidence,
            concern: reviewConcern,
            expectedOutcome:
              typeof typedParams.expectedOutcome === "string" && typedParams.expectedOutcome.trim()
                ? typedParams.expectedOutcome.trim()
                : null,
            reviewedAt: review.reviewedAt,
            modelId: review.modelId,
            modelProvider: review.modelProvider
          };
          persistedProofReview = access.store.recordPreviewProofReview(proof.proofRecordId, reviewRecord)?.proofReviews.at(-1) ?? reviewRecord;
          if (typedParams.threadId) access.store.addProofReviewFinding(typedParams.threadId, proof.verification.runId, reviewVerdict, reviewConcern);
        }

        const availableArtifactCount = proof.artifacts.length;
        const proofVerdict = availableArtifactCount > 0 ? reviewVerdict : "incomplete";
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
          `Concern=${availableArtifactCount > 0 ? reviewConcern : "Recorded proof artifacts are missing."}`,
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
            persistedProofReview,
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
        leaseId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("preview_processes"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string };
        const preview = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        const result = await access.runtimeBroker.listProcesses(preview.id);
        access.store.notePreviewLeaseActivity(preview.id);
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
        leaseId: Type.String({ minLength: 1 }),
        tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
      }),
      uiEffects: access.getToolUiEffects("preview_logs"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { leaseId: string; tail?: number };
        const preview = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        const result = await access.runtimeBroker.readLogs(preview.id, typedParams.tail ?? 200);
        access.store.notePreviewLeaseActivity(preview.id);
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
        leaseId: Type.String({ minLength: 1 }),
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
        const preview = access.requireValidatedPreview(typedParams.leaseId, null);
        assertRuntimeResourceOwned(access, preview, `Preview ${preview.id}`);
        const result = await access.runtimeBroker.execInLease({
          leaseId: preview.id,
          command,
          commandArgs,
          cwd: typedParams.cwd?.trim() || undefined,
          stdin: typedParams.stdin,
          stdinProvided: typedParams.stdinProvided === true || typeof typedParams.stdin === "string"
        });
        access.store.notePreviewLeaseActivity(preview.id);
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
  const delegationParameters = Type.Object({
    task: Type.String({ minLength: 1 }),
    goal: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String()),
    imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    fileReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
  });
  const defineDelegationTool = (name: "delegate_to_worker"): ButlerCustomTool =>
    access.defineButlerTool({
      name,
      label: "Delegate to worker",
      description: "Start a new worker workstream using the operator's selected worker model or Manor's authenticated-provider default.",
      promptSnippet: "delegate_to_worker: start execution, coding, shell work, repo setup, app build, file generation, or other task delivery. Skill installation is Butler-owned; delegate only the fresh post-install operability confirmation. Manor chooses the authenticated provider, model, harness, runtime, and thinking from operator preferences and defaults.",
      parameters: delegationParameters,
      uiEffects: access.getToolUiEffects("delegate_to_worker"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          task: string;
          goal?: string;
          cwd?: string;
          imageReferenceIds?: string[];
          fileReferenceIds?: string[];
        };
        const delegatedTask = typedParams.task;
        const delegatedGoal = typedParams.goal;
        const activeReferences = access.getActiveOperatorReferences();
        const imageReferenceIds = [...new Set([...(activeReferences?.imageReferenceIds ?? []), ...(typedParams.imageReferenceIds ?? [])])];
        const fileReferenceIds = [...new Set([...(activeReferences?.fileReferenceIds ?? []), ...(typedParams.fileReferenceIds ?? [])])];
        const workerDefaults = typeof access.getWorkerDefaults === "function" ? access.getWorkerDefaults() : null;
        const attachedWorkerThreadId = workerDefaults?.threadId?.trim() || null;
        if (attachedWorkerThreadId && taskRequiresManagedWorktree(typedParams.task)) throw new Error(`This Butler session already has Worker ${attachedWorkerThreadId}. Use Switch worker for an explicit handoff before starting isolated branch or worktree work.`);
        const workspace = await access.prepareDelegationWorkspace(typedParams.task, typedParams.cwd ?? workerDefaults?.cwd ?? undefined);
        if (attachedWorkerThreadId) {
          const attachedThread = access.store.getThread(attachedWorkerThreadId);
          const attachedCwd = attachedThread?.executionContract?.workspaceCwd ?? attachedThread?.cwd ?? workerDefaults?.cwd ?? null;
          return continueAttachedWorkerDelegation({
            access,
            threadId: attachedWorkerThreadId,
            task: delegatedTask,
            goal: delegatedGoal,
            workspace,
            attachedCwd,
            imageReferenceIds,
            fileReferenceIds
          });
        }
        const orchestration = buildDelegationRoutingDecision({ task: delegatedTask, goal: delegatedGoal });
        const repoBootstrapTask = isSharedShellRepoBootstrapTask(delegatedTask);
        const developerInstructions = await access.buildDelegationDeveloperInstructions(workspace, delegatedTask);
        const workerEffort = (workerDefaults?.effort ?? null) as ReasoningEffort | null;
        const extraNotes = repoBootstrapTask
          ? ["This job starts in the shared /repos workspace. Create or clone the repo first, then continue inside that repo."]
          : undefined;
        let preparedContract: Awaited<ReturnType<ButlerAgentToolAccess["buildDelegationContract"]>> | null = null;

        const result = await startWorkerThread(access, {
          task: delegatedGoal ? `${delegatedTask}\n\nGoal: ${delegatedGoal}` : delegatedTask,
          input: async (threadId: string) => {
            preparedContract = await access.buildDelegationContract({
                  threadId,
                  task: delegatedTask,
                  goal: delegatedGoal,
                  workspace,
                  extraNotes,
                  orchestration
                });
            if (typeof access.createOrUpdateJobPayload === "function") {
              await access.createOrUpdateJobPayload({
                threadId,
                kind: "delegation",
                instruction: preparedContract.text,
                imageReferenceIds,
                fileReferenceIds
              });
            }
            return buildWorkerInputWithReferences({
              text: preparedContract.text,
              imageStore: access.imageStore,
              imageReferenceIds,
              fileStore: access.fileStore,
              fileReferenceIds
            });
          },
          cwd: workspace.cwd,
          developerInstructions,
          effort: workerEffort,
          openWindow: true,
          runtime: "auto",
          harness: workerDefaults?.harness === "pi" ? "pi" : null,
          model: workerDefaults?.model ?? null
        });
        const delegationContract = preparedContract ?? await access.buildDelegationContract({
          threadId: result.threadId,
          task: delegatedTask,
          goal: delegatedGoal,
          workspace,
          extraNotes,
          orchestration
        });
        access.store.setThreadExecutionContract(result.threadId, delegationContract.contract);
        access.store.addEvent(result.threadId, "butler.delegation.created", "Butler created the job brief for this delegated job.");
        access.noteThreadFocus(result.threadId, name);
        const acknowledgement = access.queueDelegationAcknowledgement(
          result.threadId,
          `Accepted. I delegated this to a Worker using ${workerProviderModelRoute(result.provider, result.model)} via the ${workerHarnessLabel(result.harness)} harness in job ${result.threadId}. I will return here with the result.`,
          { runtime: result.runtime, harness: result.harness, provider: result.provider, model: result.model, effort: result.effort }
        );
        if (acknowledgement?.attached === false) {
          await deleteWorkerThread(access, result.threadId).catch(() => false);
          throw new Error("This session already has a Worker. Continue it with message_job or use Switch worker for an atomic handoff.");
        }
        await access.registerPendingChatCallback(result.threadId);
        const supervision = access.store.noteReviewedWorkerDispatch(result.threadId);

        return {
          content: [
            {
              type: "text",
              text: `Delegated the task to ${workerProviderModelRoute(result.provider, result.model)} in job ${result.threadId} from ${workspace.cwd}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
            }
          ],
          details: {
            threadId: result.threadId,
            runtime: result.runtime,
            workerHarness: result.harness,
            workerProvider: result.provider,
            workerModel: result.model,
            thinkingBudget: result.effort,
            orchestration,
            supervision,
            workspace,
            thread: access.store.getThread(result.threadId) ?? null
          }
        };
      }
    });

  return [
    defineDelegationTool("delegate_to_worker"),
    access.defineButlerTool({
      name: "run_supervision_smoke_test",
      label: "Run supervision smoke test",
      description:
        "Start a synthetic worker job that exists only to verify Butler can privately steer a worker through supervisor callbacks.",
      promptSnippet:
        "run_supervision_smoke_test: intentionally test Butler's own supervision loop. Use only when you decide the operator is asking to verify Butler supervision itself, not for ordinary implementation tasks that need tests or smoke verification.",
      parameters: Type.Object({
        totalFollowUps: Type.Optional(Type.Integer({ minimum: 2, maximum: 5 })),
        thinkingBudget: Type.Optional(stringEnumSchema(["low", "medium", "high", "xhigh"] as const))
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

        const result = await startWorkerThread(access, {
          task: delegatedTask,
          input: async (threadId: string) =>
            buildWorkerInputWithReferences({
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
          openWindow: true,
          runtime: "auto"
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
        const acknowledgement = access.queueDelegationAcknowledgement(
          result.threadId,
          `Accepted. I started a supervision smoke test in Worker job ${result.threadId} using provider ${result.provider ?? "selected"} and the ${workerHarnessLabel(result.harness)} harness. I will return here when it completes.`,
          { runtime: result.runtime, harness: result.harness, provider: result.provider, model: result.model, effort: result.effort }
        );
        if (acknowledgement?.attached === false) {
          const cleanupErrors: string[] = [];
          await stopWorkerThread(access, result.threadId).catch((error) => {
            cleanupErrors.push(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          });
          await deleteWorkerThread(access, result.threadId).catch((error) => {
            cleanupErrors.push(`delete failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          });
          access.supervisionSmokePlans.delete(result.threadId);
          if (cleanupErrors.length > 0) {
            throw new Error(`This session already has a Worker. Supervision smoke cleanup was attempted but did not finish cleanly: ${cleanupErrors.join("; ")}.`);
          }
          throw new Error("This session already has a Worker, so the supervision smoke Worker was stopped and deleted.");
        }
        await access.registerPendingChatCallback(result.threadId);
        access.store.setThreadSupervisionLimit(result.threadId, totalFollowUps + 2);
        access.supervisionSmokePlans.set(result.threadId, {
          threadId: result.threadId,
          totalFollowUps,
          followUpsSent: 0
        });
        const supervision = access.store.noteReviewedWorkerDispatch(result.threadId);

        return {
          content: [
            {
              type: "text",
              text: `Started supervision smoke test in job ${result.threadId}. Butler will privately steer ${totalFollowUps} follow-up turns. Budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
            }
          ],
          details: {
            threadId: result.threadId,
            workerHarness: result.harness,
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
