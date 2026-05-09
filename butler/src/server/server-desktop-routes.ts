import type { Express } from "express";

import { toArtifactDownloadUrl, toArtifactPublicUrl } from "./preview-verification.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import type { DesktopSessionView } from "./types.js";

type DesktopRouteAccess = {
  runtimeBroker: RuntimeBrokerClient;
  store: ButlerStateStore;
};

let desktopReconcileInFlight = false;

export function toDesktopSessionView(payload: Record<string, unknown>): DesktopSessionView {
  const tracked = payload.tracked && typeof payload.tracked === "object" ? (payload.tracked as Record<string, unknown>) : null;
  const text = (value: unknown, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  const nullableText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const numberOr = (value: unknown, fallback: number | null) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const textArray = (value: unknown) => (Array.isArray(value) ? value.map((entry) => text(entry)).filter(Boolean) : []);
  const threadId = nullableText(tracked?.threadId);
  const attachedThreadIds = [
    ...new Set([...(threadId ? [threadId] : []), ...textArray(payload.attachedThreadIds), ...textArray(tracked?.attachedThreadIds)])
  ];
  return {
    sessionId: text(payload.sessionId),
    runId: text(payload.runId),
    mode: "headful",
    title: text(payload.title, "Desktop session"),
    command: text(payload.command),
    cwd: text(payload.cwd),
    outputDir: text(payload.outputDir),
    interactive: Boolean(payload.interactive ?? tracked?.interactive),
    owner: nullableText(payload.owner) ?? nullableText(tracked?.owner),
    lockOwner: nullableText(payload.lockOwner),
    lockExpiresAt: numberOr(payload.lockExpiresAt, null),
    profileKey: nullableText(payload.profileKey) ?? nullableText(tracked?.profileKey),
    profileHome: nullableText(payload.profileHome),
    attachedThreadIds,
    workspaceKey: nullableText(payload.workspaceKey) ?? nullableText(tracked?.workspaceKey),
    workspaceName: nullableText(payload.workspaceName) ?? nullableText(tracked?.workspaceName),
    workspaceIndex: numberOr(payload.workspaceIndex, numberOr(tracked?.workspaceIndex, null)),
    startedAt: numberOr(payload.startedAt, Date.now()) ?? Date.now(),
    lastActivityAt: numberOr(payload.lastActivityAt, Date.now()) ?? Date.now(),
    pid: numberOr(payload.pid, null),
    running: Boolean(payload.running),
    exitCode: numberOr(payload.exitCode, null),
    actionCount: numberOr(payload.actionCount, 0) ?? 0,
    vncUrl: text(payload.vncUrl),
    threadId,
    projectId: text(tracked?.projectId, "desktop"),
    projectLabel: text(tracked?.projectLabel, "desktop")
  };
}

export async function reconcileDesktopSessions(access: DesktopRouteAccess): Promise<void> {
  if (desktopReconcileInFlight) {
    return;
  }

  desktopReconcileInFlight = true;
  try {
    const sessions = await access.runtimeBroker.listDesktopSessions();
    access.store.replaceDesktopSessions(
      sessions
        .filter((session) => session && typeof session.sessionId === "string")
        .map((session) => toDesktopSessionView(session as unknown as Record<string, unknown>))
    );
  } catch (error) {
    access.store.replaceDesktopSessions([]);
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Desktop proof sidecar")) {
      console.error("Desktop reconcile failed", error);
    }
  } finally {
    desktopReconcileInFlight = false;
  }
}

function isArtifactPayload(value: unknown): value is {
  filePath: string;
  url?: string | null;
  downloadUrl?: string | null;
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { filePath?: unknown }).filePath === "string" &&
    typeof (value as { fileName?: unknown }).fileName === "string"
  );
}

function decorateDesktopActionOutput(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (isArtifactPayload(value)) {
    return {
      ...value,
      url: value.url ?? toArtifactPublicUrl(value.filePath),
      downloadUrl: value.downloadUrl ?? toArtifactDownloadUrl(value.filePath)
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decorateDesktopActionOutput(entry));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decorateDesktopActionOutput(entry)]));
}

export function registerDesktopSessionRoutes(app: Express, access: DesktopRouteAccess): void {
  app.post("/api/desktop/sessions/action", async (request, response) => {
    const sessionId = typeof request.body?.sessionId === "string" ? request.body.sessionId.trim() : "";
    const actionType = typeof request.body?.actionType === "string" ? request.body.actionType.trim() : "";
    if (!sessionId || !actionType) {
      response.status(400).json({ error: "sessionId and actionType are required" });
      return;
    }

    try {
      const currentSession = access.store.listDesktopSessions().find((session) => session.sessionId === sessionId) ?? null;
      const result = await access.runtimeBroker.runDesktopSessionAction(sessionId, {
        type: actionType,
        actor: typeof request.body?.actor === "string" ? request.body.actor : "operator",
        label: typeof request.body?.label === "string" ? request.body.label : undefined,
        fileName: typeof request.body?.fileName === "string" ? request.body.fileName : undefined
      });
      access.store.upsertDesktopSession(
        toDesktopSessionView({
          ...result.state,
          tracked: currentSession
            ? {
                threadId: currentSession.threadId,
                projectId: currentSession.projectId,
                projectLabel: currentSession.projectLabel,
                title: currentSession.title,
                runId: currentSession.runId,
                outputDir: currentSession.outputDir,
                interactive: currentSession.interactive,
                owner: currentSession.owner,
                profileKey: currentSession.profileKey,
                attachedThreadIds: currentSession.attachedThreadIds,
                workspaceKey: currentSession.workspaceKey,
                workspaceName: currentSession.workspaceName,
                workspaceIndex: currentSession.workspaceIndex
              }
            : null
        })
      );
      response.json({
        ...result,
        action: {
          ...result.action,
          output: decorateDesktopActionOutput(result.action.output)
        }
      });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/desktop/sessions/stop", async (request, response) => {
    const sessionId = typeof request.body?.sessionId === "string" ? request.body.sessionId.trim() : "";
    if (!sessionId) {
      response.status(400).json({ error: "sessionId is required" });
      return;
    }

    try {
      const result = await access.runtimeBroker.stopDesktopSession(
        sessionId,
        typeof request.body?.reason === "string" ? request.body.reason : "operator stopped desktop session"
      );
      if (result.desktopProof) {
        access.store.recordBrowserVerification({
          threadId: result.desktopProof.threadId,
          projectId: result.desktopProof.projectId,
          projectLabel: result.desktopProof.projectLabel,
          title: result.desktopProof.title,
          verification: result.verification
        });
      }
      access.store.removeDesktopSession(sessionId);
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
