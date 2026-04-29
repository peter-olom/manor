import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

export function createBrokerBrowserController(options) {
  const {
    docker,
    playwrightControlUrl,
    playwrightArtifactsScratchDir,
    playwrightContainerName,
    previewNetwork,
    sharedWorkNetwork,
    previewNetworkProbeTimeoutMs,
    browserUseSessions,
    hasBrokerAccess,
    requireContainer,
    rejectIfLeaseRetainedFailed,
    rejectIfLeaseUnavailable,
    parseAliases,
    normalizeString,
    normalizePositiveInteger,
    normalizeEnv,
    normalizeCookieEntries,
    normalizeHeaderMap,
    resolveTargetHost,
    appendPreviewRoutePath,
    persistVerificationArtifacts
  } = options;

  async function callPlaywrightControl(pathname, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(new URL(pathname, playwrightControlUrl), {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {})
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({ error: "Playwright control request failed" }));
      if (!response.ok) {
        throw new Error(payload?.error || `Playwright control request failed with ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeAbsoluteHttpUrl(value) {
    const targetUrl = normalizeString(value);
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return "";
    }
    return targetUrl;
  }

  function buildDirectTargetUrl(baseTargetUrl, suffix, search = "") {
    const target = new URL(baseTargetUrl);
    target.pathname = suffix.startsWith("/") ? suffix : `/${suffix}`;
    target.search = search;
    return target.toString();
  }

  function parsePreviewRouteTarget(rawTargetUrl) {
    if (!rawTargetUrl) {
      return null;
    }

    try {
      const parsed = new URL(rawTargetUrl);
      const match = parsed.pathname.match(/^\/(?:preview|routes\/preview)\/([^/]+)(\/.*)?$/);
      if (!match) {
        return null;
      }
      return {
        leaseId: match[1],
        suffix: match[2] || "/",
        search: parsed.search || ""
      };
    } catch {
      return null;
    }
  }

  function maybeInjectPreviewHostOverride(headers, targetUrl, targetPort, aliases) {
    const hasHostHeader = Object.keys(headers).some((key) => key.toLowerCase() === "host");
    if (hasHostHeader) {
      return headers;
    }

    try {
      const parsed = new URL(targetUrl);
      const normalizedHost = parsed.hostname.toLowerCase();
      const leaseAliases = new Set(aliases.map((alias) => alias.toLowerCase()));
      if (!leaseAliases.has(normalizedHost)) {
        return headers;
      }
    } catch {
      return headers;
    }

    return {
      ...headers,
      host: `localhost:${targetPort}`
    };
  }

  function createSmokeStage(name, ok, detail, extra = {}) {
    return {
      name,
      ok: ok === null ? null : ok === true,
      detail: normalizeString(detail),
      status: typeof extra.status === "number" && Number.isFinite(extra.status) ? extra.status : null,
      hint: normalizeString(extra.hint) || null,
      failureKind: normalizeString(extra.failureKind) || null
    };
  }

  function buildPreflightError(stage) {
    const message = `${stage.name} failed: ${stage.detail}${stage.hint ? ` Hint: ${stage.hint}` : ""}`;
    const error = new Error(message);
    error.preflightStage = stage;
    return error;
  }

  function probeTcpReachability(host, portNumber, timeoutMs = previewNetworkProbeTimeoutMs) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port: portNumber });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, code: "TIMEOUT", message: `Timed out after ${timeoutMs}ms.` });
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve({ ok: true, code: null, message: "TCP connection established." });
      });

      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          ok: false,
          code: error && typeof error.code === "string" ? error.code : "ERROR",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });
  }

  function mapPreflightFailureHint(code) {
    if (code === "ECONNREFUSED" || code === "TIMEOUT") {
      return "Ensure the preview server listens on 0.0.0.0 and the configured preview port.";
    }
    if (code === "ENOTFOUND") {
      return "The preview host alias could not be resolved on the shared runtime network.";
    }
    return "Confirm the preview process is running and reachable on the configured port.";
  }

  function resolveContainerReachableHost(container, fallbackHost) {
    const networks = container?.NetworkSettings?.Networks && typeof container.NetworkSettings.Networks === "object"
      ? container.NetworkSettings.Networks
      : {};

    if (typeof fallbackHost === "string" && fallbackHost) {
      return fallbackHost;
    }

    const preview = networks[previewNetwork];
    if (preview?.IPAddress) {
      return preview.IPAddress;
    }

    const preferred = networks[sharedWorkNetwork];
    if (preferred?.IPAddress) {
      return preferred.IPAddress;
    }

    for (const value of Object.values(networks)) {
      if (value && typeof value === "object" && typeof value.IPAddress === "string" && value.IPAddress) {
        return value.IPAddress;
      }
    }

    return fallbackHost;
  }

  function resolveContainerBrowserHost(container, fallbackHost) {
    const networks = container?.NetworkSettings?.Networks && typeof container.NetworkSettings.Networks === "object"
      ? container.NetworkSettings.Networks
      : {};

    const shared = networks[sharedWorkNetwork];
    if (shared?.IPAddress) {
      return shared.IPAddress;
    }

    const preview = networks[previewNetwork];
    if (preview?.IPAddress) {
      return preview.IPAddress;
    }

    for (const [networkName, value] of Object.entries(networks)) {
      if (
        networkName.startsWith("manor_stack_") &&
        value &&
        typeof value === "object" &&
        typeof value.IPAddress === "string" &&
        value.IPAddress
      ) {
        return value.IPAddress;
      }
    }

    if (typeof fallbackHost === "string" && fallbackHost) {
      return fallbackHost;
    }

    for (const value of Object.values(networks)) {
      if (value && typeof value === "object" && typeof value.IPAddress === "string" && value.IPAddress) {
        return value.IPAddress;
      }
    }

    return fallbackHost;
  }

  function resolvePreviewBrowserTarget(input) {
    const targetHost = resolveTargetHost(input.containerName, input.aliases) || input.containerName;
    const reachableHost = resolveContainerReachableHost(input.container, targetHost);
    const browserHost = resolveContainerBrowserHost(input.container, targetHost);
    const baseTargetUrl = `http://${browserHost}:${input.targetPort}/`;
    const requestedTargetUrl = normalizeAbsoluteHttpUrl(input.requestedTargetUrl);

    if (!requestedTargetUrl) {
      return {
        targetHost,
        reachableHost,
        targetUrl: appendPreviewRoutePath(baseTargetUrl, input.path),
        translatedFromPreviewRoute: false,
        customTarget: false
      };
    }

    const routeTarget = parsePreviewRouteTarget(requestedTargetUrl);
    if (!routeTarget) {
      return {
        targetHost,
        reachableHost,
        targetUrl: requestedTargetUrl,
        translatedFromPreviewRoute: false,
        customTarget: true
      };
    }

    if (routeTarget.leaseId !== input.leaseId) {
      throw new Error(
        `Requested targetUrl points to preview ${routeTarget.leaseId}, but this request is for preview ${input.leaseId}.`
      );
    }

    return {
      targetHost,
      reachableHost,
      targetUrl: buildDirectTargetUrl(baseTargetUrl, routeTarget.suffix, routeTarget.search),
      translatedFromPreviewRoute: true,
      customTarget: false
    };
  }

  async function runPreviewSmokePreflight(input) {
    const running = Boolean(input.container?.State?.Running);
    const processUp = createSmokeStage(
      "process_up",
      running,
      running ? "Preview container is running." : "Preview container is not running.",
      {
        hint: running ? null : "Start the preview process and confirm it remains running before browser smoke.",
        failureKind: "preview"
      }
    );
    if (!running) {
      throw buildPreflightError(processUp);
    }

    const probe = await probeTcpReachability(input.reachableHost, input.targetPort, previewNetworkProbeTimeoutMs);
    const networkReachable = createSmokeStage(
      "network_reachable",
      probe.ok,
      probe.ok
        ? `Shared network can reach ${input.reachableHost}:${input.targetPort}.`
        : `Shared network could not reach ${input.reachableHost}:${input.targetPort} (${probe.code || "ERROR"}: ${probe.message}).`,
      {
        hint: probe.ok ? null : mapPreflightFailureHint(probe.code),
        failureKind: "readiness"
      }
    );
    if (!probe.ok) {
      throw buildPreflightError(networkReachable);
    }

    return {
      processUp,
      networkReachable,
      routeAuth: createSmokeStage(
        "route_auth",
        true,
        input.customTarget
          ? "Custom target URL provided; route-auth stage handled by target endpoint."
          : input.translatedFromPreviewRoute
            ? "Brokered preview route target was translated to direct runtime target."
            : "Direct runtime target selected; no preview route auth gate required."
      )
    };
  }

  function buildBrowserUseOutputDir(scope, runId) {
    if (scope.kind === "preview") {
      return path.posix.join(playwrightArtifactsScratchDir, "browser-use", "preview", scope.leaseId, runId);
    }
    return path.posix.join(playwrightArtifactsScratchDir, "browser-use", "browser", scope.threadId, runId);
  }

  async function startPlaywrightBrowserUseSession(input) {
    const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = crypto.randomUUID();
    const outputDir = buildBrowserUseOutputDir(input.scope, runId);
    const payload = await callPlaywrightControl("/sessions", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        runId,
        mode: input.mode,
        targetUrl: input.targetUrl,
        outputDir,
        resolution: input.resolution,
        waitForSelector: input.waitForSelector,
        postLoadWaitMs: input.postLoadWaitMs,
        headers: input.headers,
        cookies: input.cookies,
        preflightStages: input.preflightStages || undefined
      })
    });

    const summary = payload?.session;
    if (!summary || typeof summary !== "object" || typeof summary.sessionId !== "string") {
      throw new Error("Playwright control did not return a valid session summary.");
    }

    browserUseSessions.set(summary.sessionId, {
      kind: input.scope.kind,
      leaseId: input.scope.kind === "preview" ? input.scope.leaseId : null,
      threadId: input.scope.kind === "browser" ? input.scope.threadId : null,
      projectId: input.scope.kind === "browser" ? input.scope.projectId : null,
      projectLabel: input.scope.kind === "browser" ? input.scope.projectLabel : null,
      title: input.scope.kind === "browser" ? input.scope.title : null,
      runId,
      outputDir,
      preflightStages: input.preflightStages || null
    });

    return {
      sessionId: summary.sessionId,
      runId,
      mode: summary.mode,
      targetUrl: summary.targetUrl,
      title: summary.title || "",
      url: summary.url || summary.targetUrl,
      status: typeof summary.status === "number" ? summary.status : null,
      resolution: typeof summary.resolution === "string" ? summary.resolution : undefined,
      viewport: summary.viewport && typeof summary.viewport === "object" ? summary.viewport : undefined,
      startedAt: typeof summary.startedAt === "number" ? summary.startedAt : Date.now(),
      actionCount: typeof summary.actionCount === "number" ? summary.actionCount : 0
    };
  }

  async function closePlaywrightBrowserUseSession(sessionId, reason) {
    const tracked = browserUseSessions.get(sessionId);
    if (!tracked) {
      throw new Error(`Browser session ${sessionId} was not found.`);
    }

    const payload = await callPlaywrightControl(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      body: JSON.stringify({ reason })
    });
    const verification = payload?.verification;
    if (!verification || typeof verification !== "object") {
      throw new Error("Playwright control did not return verification output.");
    }

    const playwrightContainer = docker.getContainer(playwrightContainerName);
    await playwrightContainer.inspect();
    const persisted = await persistVerificationArtifacts(
      playwrightContainer,
      verification,
      tracked.outputDir,
      tracked.kind === "preview"
        ? { leaseId: tracked.leaseId, runId: tracked.runId }
        : { kind: "browser", threadId: tracked.threadId, runId: tracked.runId }
    );

    browserUseSessions.delete(sessionId);
    return { tracked, verification: persisted };
  }

  function listPreviewSessionIdsForLease(leaseId) {
    return [...browserUseSessions.entries()]
      .filter(([, metadata]) => metadata.kind === "preview" && metadata.leaseId === leaseId)
      .map(([sessionId]) => sessionId);
  }

  function registerRoutes(app) {
    app.post("/leases/:leaseId/browser-sessions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      if (rejectIfLeaseRetainedFailed(request.params.leaseId, response)) {
        return;
      }
      const required = await requireContainer(request.params.leaseId, response);
      if (!required) {
        return;
      }
      if (rejectIfLeaseUnavailable(required, request.params.leaseId, response)) {
        return;
      }

      try {
        const labels = required.container.Config?.Labels || {};
        const aliases = parseAliases(labels["manor.aliases"]);
        const targetPort =
          Number(required.container.Config?.Env?.find((entry) => entry.startsWith("PORT="))?.slice(5) || "3000");
        const targetResolution = resolvePreviewBrowserTarget({
          leaseId: request.params.leaseId,
          containerName: required.containerName,
          container: required.container,
          aliases,
          targetPort,
          requestedTargetUrl: request.body?.targetUrl,
          path: request.body?.path
        });
        const targetUrl = targetResolution.targetUrl;
        if (!/^https?:\/\//i.test(targetUrl)) {
          response.status(400).json({ error: "targetUrl must be an absolute http or https URL when provided." });
          return;
        }

        const preflightStages = await runPreviewSmokePreflight({
          container: required.container,
          targetPort,
          reachableHost: targetResolution.reachableHost,
          translatedFromPreviewRoute: targetResolution.translatedFromPreviewRoute,
          customTarget: targetResolution.customTarget
        });

        const mode = request.body?.mode === "headful" ? "headful" : "headless";
        const resolution = normalizeString(request.body?.resolution) || undefined;
        const waitForSelector = normalizeString(request.body?.waitForSelector) || undefined;
        const postLoadWaitMs = normalizePositiveInteger(request.body?.postLoadWaitMs) ?? undefined;
        const hostAliases = [
          required.containerName,
          ...aliases,
          targetResolution.targetHost,
          targetResolution.reachableHost
        ].filter(Boolean);
        const headers = maybeInjectPreviewHostOverride(
          normalizeHeaderMap(request.body?.headers),
          targetUrl,
          targetPort,
          hostAliases
        );
        const cookies = normalizeCookieEntries(request.body?.cookies);
        const sessionCookie = normalizeString(request.body?.sessionCookie);
        if (sessionCookie) {
          cookies.push({ name: "better-auth.session_token", value: sessionCookie });
        }

        const session = await startPlaywrightBrowserUseSession({
          mode,
          targetUrl,
          resolution,
          waitForSelector,
          postLoadWaitMs,
          headers,
          cookies,
          preflightStages,
          scope: {
            kind: "preview",
            leaseId: request.params.leaseId
          }
        });
        response.json({ ok: true, session });
      } catch (error) {
        const preflightStage =
          typeof error === "object" && error !== null && "preflightStage" in error ? error.preflightStage : null;
        if (preflightStage && typeof preflightStage === "object") {
          response.status(400).json({
            error: error instanceof Error ? error.message : String(error),
            stage: preflightStage.name,
            hint: preflightStage.hint || null,
            failureKind: preflightStage.failureKind || "readiness"
          });
          return;
        }
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post("/browser/sessions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }

      const threadId = normalizeString(request.body?.threadId);
      const projectId = normalizeString(request.body?.projectId);
      const projectLabel = normalizeString(request.body?.projectLabel);
      const title = normalizeString(request.body?.title) || "Browser use session";
      const targetUrl = normalizeAbsoluteHttpUrl(request.body?.targetUrl);
      if (!threadId || !projectId || !projectLabel || !targetUrl) {
        response.status(400).json({ error: "threadId, projectId, projectLabel, and targetUrl are required." });
        return;
      }

      try {
        const mode = request.body?.mode === "headful" ? "headful" : "headless";
        const resolution = normalizeString(request.body?.resolution) || undefined;
        const waitForSelector = normalizeString(request.body?.waitForSelector) || undefined;
        const postLoadWaitMs = normalizePositiveInteger(request.body?.postLoadWaitMs) ?? undefined;
        const headers = normalizeHeaderMap(request.body?.headers);
        const cookies = normalizeCookieEntries(request.body?.cookies);
        const sessionCookie = normalizeString(request.body?.sessionCookie);
        if (sessionCookie) {
          cookies.push({ name: "better-auth.session_token", value: sessionCookie });
        }

        const session = await startPlaywrightBrowserUseSession({
          mode,
          targetUrl,
          resolution,
          waitForSelector,
          postLoadWaitMs,
          headers,
          cookies,
          scope: {
            kind: "browser",
            threadId,
            projectId,
            projectLabel,
            title
          }
        });
        response.json({ ok: true, session });
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get("/browser/sessions/:sessionId", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const sessionId = normalizeString(request.params.sessionId);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required." });
        return;
      }
      if (!browserUseSessions.has(sessionId)) {
        response.status(404).json({ error: `Browser session ${sessionId} was not found.` });
        return;
      }

      try {
        const payload = await callPlaywrightControl(`/sessions/${encodeURIComponent(sessionId)}`, {
          method: "GET"
        });
        response.json({
          ...payload,
          tracked: browserUseSessions.get(sessionId) ?? null
        });
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.post("/browser/sessions/:sessionId/actions", async (request, response) => {
      if (!hasBrokerAccess(request)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      const sessionId = normalizeString(request.params.sessionId);
      if (!sessionId) {
        response.status(400).json({ error: "sessionId is required." });
        return;
      }
      if (!browserUseSessions.has(sessionId)) {
        response.status(404).json({ error: `Browser session ${sessionId} was not found.` });
        return;
      }

      try {
        const payload = await callPlaywrightControl(`/sessions/${encodeURIComponent(sessionId)}/actions`, {
          method: "POST",
          body: JSON.stringify(request.body ?? {})
        });
        response.json(payload);
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.delete("/browser/sessions/:sessionId", async (request, response) => {
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
        const { verification, tracked } = await closePlaywrightBrowserUseSession(
          sessionId,
          normalizeString(request.body?.reason) || "browser session stop"
        );
        if (tracked.kind === "browser") {
          response.json({
            ok: true,
            verification,
            tracked,
            browserProof: {
              threadId: tracked.threadId,
              projectId: tracked.projectId,
              projectLabel: tracked.projectLabel,
              title: tracked.title,
              targetUrl: verification.url
            }
          });
          return;
        }
        response.json({ ok: true, verification, tracked });
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  return {
    registerRoutes,
    closePlaywrightBrowserUseSession,
    listPreviewSessionIdsForLease
  };
}
