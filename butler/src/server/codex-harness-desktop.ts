import { decoratePreviewVerification } from "./preview-verification.js";
import { ButlerStateStore } from "./state-store.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { CodexThreadRecord } from "./types.js";
import {
  type HarnessCapability,
  normalizeEnv,
  normalizePositiveInteger,
  normalizeString
} from "./codex-harness-helpers.js";

type HarnessActionResult = {
  text: string;
  data: Record<string, unknown>;
};

function normalizeStringArray(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(entries.map((entry) => normalizeString(entry)).filter(Boolean))];
}

export async function handleHarnessDesktopAction(input: {
  action: string;
  params: Record<string, unknown>;
  capability: HarnessCapability;
  thread: CodexThreadRecord;
  runtimeBroker: RuntimeBrokerClient;
  store: ButlerStateStore;
  resolveWorkspaceProject: (cwd: string, thread: CodexThreadRecord) => { id: string; label: string };
}): Promise<HarnessActionResult | null> {
  const { action, params, capability, thread, runtimeBroker, store, resolveWorkspaceProject } = input;

  if (action === "desktop.status") {
    const status = await runtimeBroker.getDesktopProofStatus();
    return {
      text: status.available
        ? `Desktop proof sidecar is ready. Active sessions=${status.health?.activeSessionCount ?? 0}.`
        : `Desktop proof sidecar is unavailable. ${status.message}`,
      data: { status }
    };
  }

  if (action === "desktop.use.start") {
    const command = normalizeString(params.command);
    const title = normalizeString(params.title) || command || "Desktop proof session";
    const cwd = normalizeString(params.cwd) || capability.cwd;
    const env = normalizeEnv(params.env);
    const waitMs = normalizePositiveInteger(params.waitMs) ?? undefined;
    const interactive = params.interactive === true;
    const owner = normalizeString(params.owner) || "agent";
    const profileKey = normalizeString(params.profileKey) || undefined;
    const attachedThreadIds = [...new Set([capability.threadId, ...normalizeStringArray(params.attachedThreadIds)])];
    const workspaceKey = normalizeString(params.workspaceKey) || capability.threadId;
    const workspaceName = normalizeString(params.workspaceName) || workspaceKey;
    if (!command) {
      throw new Error("desktop.use.start requires command");
    }

    const project = resolveWorkspaceProject(capability.cwd, thread);
    const session = await runtimeBroker.startDesktopSession({
      threadId: capability.threadId,
      projectId: project.id,
      projectLabel: project.label,
      title,
      command,
      cwd,
      env: Object.keys(env).length > 0 ? env : undefined,
      interactive,
      owner,
      profileKey,
      attachedThreadIds,
      workspaceKey,
      workspaceName,
      waitMs
    });
    return {
      text: `Desktop proof session started. Session=${session.sessionId}. Workspace=${session.workspaceName ?? workspaceName}.`,
      data: { session }
    };
  }

  if (action === "desktop.use.list") {
    const sessions = await runtimeBroker.listDesktopSessions(capability.threadId);
    return {
      text:
        sessions.length === 0
          ? "No desktop sessions are active for this job."
          : sessions
              .map(
                (session, index) =>
                  `${index + 1}. ${session.title} | session=${session.sessionId} | ${session.running ? "running" : "stopped"} | workspace=${session.workspaceName ?? "(none)"} | attached=${session.attachedThreadIds?.join(",") || "(none)"} | actions=${session.actionCount} | vnc=${session.vncUrl}`
              )
              .join("\n"),
      data: { sessions }
    };
  }

  if (action === "desktop.use.state") {
    const sessionId = normalizeString(params.sessionId);
    if (!sessionId) {
      throw new Error("desktop.use.state requires sessionId");
    }
    const result = await runtimeBroker.inspectDesktopSession(sessionId);
    return {
      text: `Desktop session ${result.session.sessionId} is ${result.session.running ? "running" : "stopped"}. Actions=${result.session.actionCount}.`,
      data: { session: result.session }
    };
  }

  if (action === "desktop.use.action") {
    const sessionId = normalizeString(params.sessionId);
    const actionType = normalizeString(params.actionType || params.type);
    if (!sessionId) {
      throw new Error("desktop.use.action requires sessionId");
    }
    if (!actionType) {
      throw new Error("desktop.use.action requires actionType");
    }

    const result = await runtimeBroker.runDesktopSessionAction(sessionId, {
      type: actionType,
      label: normalizeString(params.label) || undefined,
      fileName: normalizeString(params.fileName) || undefined,
      ms: normalizePositiveInteger(params.ms) ?? undefined,
      ttlMs: normalizePositiveInteger(params.ttlMs) ?? undefined,
      x: typeof params.x === "number" && Number.isFinite(params.x) ? params.x : undefined,
      y: typeof params.y === "number" && Number.isFinite(params.y) ? params.y : undefined,
      toX: typeof params.toX === "number" && Number.isFinite(params.toX) ? params.toX : undefined,
      toY: typeof params.toY === "number" && Number.isFinite(params.toY) ? params.toY : undefined,
      button: normalizePositiveInteger(params.button) ?? undefined,
      windowId: normalizeString(params.windowId) || undefined,
      key: normalizeString(params.key) || undefined,
      text: typeof params.text === "string" ? params.text : undefined,
      targetText: normalizeString(params.targetText) || undefined,
      matchMode: normalizeString(params.matchMode) || undefined,
      delayMs: normalizePositiveInteger(params.delayMs) ?? undefined,
      actor: normalizeString(params.actor) || "agent",
      force: params.force === true,
      cdpUrl: normalizeString(params.cdpUrl) || undefined,
      cdpPort: normalizePositiveInteger(params.cdpPort) ?? undefined
    });
    return {
      text: `Desktop action ${result.action.type} completed. Actions=${result.state.actionCount}.`,
      data: { result }
    };
  }

  if (action === "desktop.use.stop") {
    const sessionId = normalizeString(params.sessionId);
    const reason = normalizeString(params.reason) || undefined;
    if (!sessionId) {
      throw new Error("desktop.use.stop requires sessionId");
    }

    const result = await runtimeBroker.stopDesktopSession(sessionId, reason);
    const verification = decoratePreviewVerification(result.verification);
    if (result.desktopProof) {
      store.recordBrowserVerification({
        threadId: result.desktopProof.threadId,
        projectId: result.desktopProof.projectId,
        projectLabel: result.desktopProof.projectLabel,
        title: result.desktopProof.title,
        verification
      });
    }

    const remediationHint = verification.failureKind !== "none" ? verification.diagnostics?.remediationHints?.[0] ?? "" : "";
    const signalSummary =
      verification.failureKind === "none"
        ? "Signals=none."
        : `Signals=${verification.failureKind}.${remediationHint ? ` Hint: ${remediationHint}` : ""}`;
    return {
      text: `Desktop proof session stopped with proof run ${verification.runId}. ${signalSummary}`,
      data: { verification, desktopProof: result.desktopProof ?? null }
    };
  }

  return null;
}
