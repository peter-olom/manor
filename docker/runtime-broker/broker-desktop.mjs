import crypto from "node:crypto";
import path from "node:path";

export function createBrokerDesktopController(options) {
  const {
    docker,
    desktopProofControlUrl,
    desktopProofContainerName,
    desktopProofArtifactsScratchDir,
    desktopProofSessions,
    hasBrokerAccess,
    normalizeString,
    normalizePositiveInteger,
    normalizeEnv,
    persistArtifactFiles,
    persistVerificationArtifacts
  } = options;

  async function callDesktopControl(pathname, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(new URL(pathname, desktopProofControlUrl), {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {})
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({ error: "Desktop proof request failed" }));
      if (!response.ok) {
        throw new Error(payload?.error || `Desktop proof request failed with ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function desktopUnavailableError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|aborted|not found/i.test(message)) {
      return new Error("Desktop proof sidecar is not running. Enable the desktop profile and retry.");
    }
    return error;
  }

  async function inspectDesktopSidecar() {
    const container = docker.getContainer(desktopProofContainerName);
    const inspected = await container.inspect().catch(() => null);
    if (!inspected) {
      return {
        available: false,
        status: "missing",
        message: "Desktop proof sidecar has not been created.",
        health: null
      };
    }

    if (!inspected.State?.Running) {
      return {
        available: false,
        status: inspected.State?.Status || "stopped",
        message: "Desktop proof sidecar is not running.",
        health: null
      };
    }

    try {
      const health = await callDesktopControl("/health", { method: "GET" });
      return {
        available: true,
        status: inspected.State?.Status || "running",
        message: "Desktop proof sidecar is ready.",
        health
      };
    } catch (error) {
      return {
        available: false,
        status: inspected.State?.Status || "running",
        message: error instanceof Error ? error.message : String(error),
        health: null
      };
    }
  }

  function buildDesktopOutputDir(threadId, runId) {
    return path.posix.join(desktopProofArtifactsScratchDir, "desktop-proof", threadId || "desktop", runId);
  }

  function normalizeStringList(value) {
    const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return [...new Set(entries.map((entry) => normalizeString(entry)).filter(Boolean))];
  }

  function buildDesktopSessionTarget(input) {
    const threadId = normalizeString(input.threadId) || "desktop";
    const attachedThreadIds = normalizeStringList(input.attachedThreadIds);
    if (threadId && threadId !== "desktop" && !attachedThreadIds.includes(threadId)) {
      attachedThreadIds.unshift(threadId);
    }
    const workspaceKey = normalizeString(input.workspaceKey) || attachedThreadIds[0] || threadId || "desktop";
    const workspaceName = normalizeString(input.workspaceName) || workspaceKey;
    return { threadId, attachedThreadIds, workspaceKey, workspaceName };
  }

  function desktopSessionMatchesThread(session, threadId) {
    if (!threadId) {
      return true;
    }
    const trackedAttached = Array.isArray(session.tracked?.attachedThreadIds) ? session.tracked.attachedThreadIds : [];
    const summaryAttached = Array.isArray(session.attachedThreadIds) ? session.attachedThreadIds : [];
    return (
      session.tracked?.threadId === threadId ||
      trackedAttached.includes(threadId) ||
      summaryAttached.includes(threadId) ||
      session.sessionId === threadId
    );
  }

  async function startDesktopSession(input) {
    const status = await inspectDesktopSidecar();
    if (!status.available) {
      throw new Error(status.message);
    }

    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = crypto.randomUUID();
    const target = buildDesktopSessionTarget(input);
    const outputDir = buildDesktopOutputDir(target.threadId, runId);
    const payload = await callDesktopControl("/sessions", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        runId,
        title: input.title,
        command: input.command,
        cwd: input.cwd,
        outputDir,
        env: input.env,
        interactive: input.interactive,
        owner: input.owner,
        profileKey: input.profileKey,
        attachedThreadIds: target.attachedThreadIds,
        workspaceKey: target.workspaceKey,
        workspaceName: target.workspaceName,
        waitMs: input.waitMs
      })
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });

    const summary = payload?.session;
    if (!summary || typeof summary !== "object" || typeof summary.sessionId !== "string") {
      throw new Error("Desktop proof sidecar did not return a valid session summary.");
    }

    desktopProofSessions.set(summary.sessionId, {
      threadId: target.threadId,
      attachedThreadIds: target.attachedThreadIds,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      title: input.title,
      runId,
      outputDir,
      interactive: Boolean(input.interactive),
      owner: input.owner || "agent",
      profileKey: input.profileKey || null,
      workspaceKey: summary.workspaceKey || target.workspaceKey,
      workspaceName: summary.workspaceName || target.workspaceName,
      workspaceIndex: typeof summary.workspaceIndex === "number" ? summary.workspaceIndex : null
    });

    return summary;
  }

  async function listDesktopSessions(threadId = null) {
    const status = await inspectDesktopSidecar();
    if (!status.available) {
      return [];
    }

    const payload = await callDesktopControl("/sessions", { method: "GET" }).catch((error) => {
      throw desktopUnavailableError(error);
    });
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    return sessions
      .map((session) => ({
        ...session,
        tracked: desktopProofSessions.get(session.sessionId) ?? null
      }))
      .filter((session) => desktopSessionMatchesThread(session, threadId));
  }

  async function inspectDesktopSession(sessionId) {
    return callDesktopControl(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET"
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });
  }

  async function runDesktopSessionAction(sessionId, input) {
    const payload = await callDesktopControl(`/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: "POST",
      body: JSON.stringify(input)
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });
    return persistActionArtifacts(sessionId, payload);
  }

  function isArtifactDescriptor(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.filePath === "string" &&
      typeof value.fileName === "string" &&
      typeof value.contentType === "string"
    );
  }

  function collectActionArtifacts(value, artifacts = [], seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return artifacts;
    }
    seen.add(value);
    if (isArtifactDescriptor(value)) {
      artifacts.push(value);
      return artifacts;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectActionArtifacts(entry, artifacts, seen);
      }
      return artifacts;
    }
    for (const entry of Object.values(value)) {
      collectActionArtifacts(entry, artifacts, seen);
    }
    return artifacts;
  }

  function replaceActionArtifacts(value, persistedByRemotePath, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return value;
    }
    seen.add(value);
    if (isArtifactDescriptor(value)) {
      return persistedByRemotePath.get(value.filePath) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => replaceActionArtifacts(entry, persistedByRemotePath, seen));
    }
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = replaceActionArtifacts(entry, persistedByRemotePath, seen);
    }
    return next;
  }

  async function persistActionArtifacts(sessionId, payload) {
    const artifacts = collectActionArtifacts(payload?.action?.output);
    if (artifacts.length === 0) {
      return payload;
    }

    const tracked = desktopProofSessions.get(sessionId);
    const state = payload?.state && typeof payload.state === "object" ? payload.state : {};
    const runId = tracked?.runId || normalizeString(state.runId);
    if (!runId) {
      return payload;
    }

    const desktopContainer = docker.getContainer(desktopProofContainerName);
    await desktopContainer.inspect();
    const persistedArtifacts = await persistArtifactFiles(desktopContainer, artifacts, {
      kind: "browser",
      threadId: tracked?.threadId || tracked?.attachedThreadIds?.[0] || "desktop",
      runId
    });
    if (persistedArtifacts.length === 0) {
      return payload;
    }

    const persistedByRemotePath = new Map();
    for (const [index, artifact] of artifacts.entries()) {
      const persisted = persistedArtifacts[index];
      if (persisted?.filePath) {
        persistedByRemotePath.set(artifact.filePath, persisted);
      }
    }

    return {
      ...payload,
      action: {
        ...payload.action,
        output: replaceActionArtifacts(payload.action.output, persistedByRemotePath)
      }
    };
  }

  async function stopDesktopSession(sessionId, reason) {
    let tracked = desktopProofSessions.get(sessionId);
    const inspected = tracked ? null : await inspectDesktopSession(sessionId).catch(() => null);
    if (!tracked && inspected?.session) {
      tracked = {
        threadId: "desktop",
        projectId: "desktop",
        projectLabel: "desktop",
        title: inspected.session.title || "Desktop proof session",
        runId: inspected.session.runId,
        outputDir: inspected.session.outputDir,
        interactive: Boolean(inspected.session.interactive),
        owner: inspected.session.owner || "agent",
        profileKey: inspected.session.profileKey || null,
        attachedThreadIds: normalizeStringList(inspected.session.attachedThreadIds),
        workspaceKey: normalizeString(inspected.session.workspaceKey) || null,
        workspaceName: normalizeString(inspected.session.workspaceName) || null,
        workspaceIndex: typeof inspected.session.workspaceIndex === "number" ? inspected.session.workspaceIndex : null
      };
    }
    if (!tracked) {
      throw new Error(`Desktop session ${sessionId} was not found.`);
    }

    const payload = await callDesktopControl(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason })
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });
    const verification = payload?.verification;
    if (!verification || typeof verification !== "object") {
      throw new Error("Desktop proof sidecar did not return verification output.");
    }

    const desktopContainer = docker.getContainer(desktopProofContainerName);
    await desktopContainer.inspect();
    const persisted = await persistVerificationArtifacts(desktopContainer, verification, tracked.outputDir, {
      kind: "browser",
      threadId: tracked.threadId || tracked.attachedThreadIds?.[0] || "desktop",
      runId: tracked.runId
    });

    desktopProofSessions.delete(sessionId);
    return { tracked, verification: persisted };
  }

  function registerRoutes(app) {
    app.get("/desktop/status", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        response.json(await inspectDesktopSidecar());
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get("/desktop/sessions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        response.json(await listDesktopSessions(normalizeString(request.query?.threadId) || null));
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post("/desktop/sessions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }

      const threadId = normalizeString(request.body?.threadId);
      const projectId = normalizeString(request.body?.projectId);
      const projectLabel = normalizeString(request.body?.projectLabel);
      const title = normalizeString(request.body?.title) || "Desktop proof session";
      const command = normalizeString(request.body?.command);
      const cwd = normalizeString(request.body?.cwd) || "/repos";
      const env = normalizeEnv(request.body?.env);
      const interactive =
        request.body?.interactive === true || ["1", "true", "yes", "on"].includes(normalizeString(request.body?.interactive).toLowerCase());
      const owner = normalizeString(request.body?.owner) || "agent";
      const profileKey = normalizeString(request.body?.profileKey);
      const attachedThreadIds = normalizeStringList(request.body?.attachedThreadIds);
      const workspaceKey = normalizeString(request.body?.workspaceKey);
      const workspaceName = normalizeString(request.body?.workspaceName);
      const waitMs = normalizePositiveInteger(request.body?.waitMs) ?? undefined;
      if (!threadId || !projectId || !projectLabel || !command) {
        response.status(400).json({ error: "threadId, projectId, projectLabel, and command are required." });
        return;
      }

      try {
        const session = await startDesktopSession({
          threadId,
          projectId,
          projectLabel,
          title,
          command,
          cwd,
          env,
          interactive,
          owner,
          profileKey: profileKey || undefined,
          attachedThreadIds,
          workspaceKey: workspaceKey || undefined,
          workspaceName: workspaceName || undefined,
          waitMs
        });
        response.json({ ok: true, session });
      } catch (error) {
        response.status(503).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get("/desktop/sessions/:sessionId", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const sessionId = normalizeString(request.params.sessionId);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required." });
        return;
      }

      try {
        const payload = await inspectDesktopSession(sessionId);
        response.json({
          ...payload,
          tracked: desktopProofSessions.get(sessionId) ?? null
        });
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post("/desktop/sessions/:sessionId/actions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const sessionId = normalizeString(request.params.sessionId);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required." });
        return;
      }

      try {
        response.json(await runDesktopSessionAction(sessionId, request.body ?? {}));
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.delete("/desktop/sessions/:sessionId", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const sessionId = normalizeString(request.params.sessionId);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required." });
        return;
      }

      try {
        const { verification, tracked } = await stopDesktopSession(
          sessionId,
          normalizeString(request.body?.reason) || "desktop session stop"
        );
        response.json({
          ok: true,
          verification,
          tracked,
          desktopProof: {
            threadId: tracked.threadId,
            projectId: tracked.projectId,
            projectLabel: tracked.projectLabel,
            title: tracked.title
          }
        });
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  return {
    registerRoutes,
    inspectDesktopSidecar,
    startDesktopSession,
    listDesktopSessions,
    inspectDesktopSession,
    runDesktopSessionAction,
    stopDesktopSession
  };
}
