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

  async function startDesktopSession(input) {
    const status = await inspectDesktopSidecar();
    if (!status.available) {
      throw new Error(status.message);
    }

    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = crypto.randomUUID();
    const outputDir = buildDesktopOutputDir(input.threadId, runId);
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
      threadId: input.threadId,
      projectId: input.projectId,
      projectLabel: input.projectLabel,
      title: input.title,
      runId,
      outputDir
    });

    return summary;
  }

  async function inspectDesktopSession(sessionId) {
    return callDesktopControl(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET"
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });
  }

  async function runDesktopSessionAction(sessionId, input) {
    return callDesktopControl(`/sessions/${encodeURIComponent(sessionId)}/actions`, {
      method: "POST",
      body: JSON.stringify(input)
    }).catch((error) => {
      throw desktopUnavailableError(error);
    });
  }

  async function stopDesktopSession(sessionId, reason) {
    const tracked = desktopProofSessions.get(sessionId);
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
      threadId: tracked.threadId,
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
      if (!desktopProofSessions.has(sessionId)) {
        response.status(404).json({ error: `Desktop session ${sessionId} was not found.` });
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
      if (!desktopProofSessions.has(sessionId)) {
        response.status(404).json({ error: `Desktop session ${sessionId} was not found.` });
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
    inspectDesktopSession,
    runDesktopSessionAction,
    stopDesktopSession
  };
}
