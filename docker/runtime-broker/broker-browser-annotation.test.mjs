import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createBrokerBrowserController } from "./broker-browser.mjs";

const source = await readFile(new URL("./broker-browser.mjs", import.meta.url), "utf8");

test("preview browser proof sessions do not request the annotation layer by default", () => {
  const previewSessionBlock = source.slice(source.indexOf('app.post("/leases/:leaseId/browser-sessions"'), source.indexOf('app.post("/browser/sessions"'));
  assert.doesNotMatch(previewSessionBlock, /previewAnnotationLayer:\s*true/);
});

test("generic browser sessions do not enable annotations by default", () => {
  const genericSessionBlock = source.slice(source.indexOf('app.post("/browser/sessions"'), source.indexOf('app.get("/browser/sessions/:sessionId"'));
  assert.doesNotMatch(genericSessionBlock, /previewAnnotationLayer:\s*true/);
});


test("preview browser sessions wire annotation insertion through Butler internal endpoint", () => {
  assert.match(source, /api\/internal\/browser-annotations\/insert/);
  assert.match(source, /annotationTargets/);
  assert.match(source, /thread:\$\{scope.threadId\}/);
});

test("browser proof control retries transient sidecar fetch failures", async () => {
  let attempts = 0;
  const routes = new Map();
  const app = {
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    delete(path, handler) {
      routes.set(`DELETE ${path}`, handler);
    }
  };
  const browserUseSessions = new Map();
  const controller = createBrokerBrowserController({
    docker: {},
    playwrightControlUrl: "http://playwright.test",
    playwrightArtifactsScratchDir: "/tmp/manor-playwright-artifacts",
    playwrightContainerName: "manor-playwright",
    previewNetwork: "manor_preview",
    sharedWorkNetwork: "manor_work",
    previewNetworkProbeTimeoutMs: 10,
    browserUseSessions,
    hasBrokerAccess: () => true,
    requireContainer: async () => null,
    rejectIfLeaseRetainedFailed: () => false,
    rejectIfLeaseUnavailable: () => false,
    parseAliases: () => [],
    normalizeString: (value) => (typeof value === "string" ? value.trim() : ""),
    normalizePositiveInteger: (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
    },
    normalizeEnv: () => ({}),
    normalizeCookieEntries: () => [],
    normalizeHeaderMap: () => ({}),
    resolveTargetHost: (containerName) => containerName,
    appendPreviewRoutePath: (baseUrl, routePath = "") => new URL(routePath.replace(/^\//, ""), baseUrl).toString(),
    persistVerificationArtifacts: async () => ({}),
    internalOperatorBaseUrl: "http://butler:8080",
    brokerToken: "broker-token",
    playwrightControlRetryDelaysMs: [1],
    playwrightControlFetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNRESET" };
        throw error;
      }
      return new Response(
        JSON.stringify({
          session: {
            sessionId: "session-after-retry",
            mode: "headless",
            targetUrl: "http://example.test",
            status: 200,
            startedAt: 123
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });
  controller.registerRoutes(app);

  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
  const handler = routes.get("POST /browser/sessions");
  assert.equal(typeof handler, "function");
  await handler(
    {
      body: {
        threadId: "thread-1",
        projectId: "project-1",
        projectLabel: "Project 1",
        targetUrl: "http://example.test"
      }
    },
    response
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.session.sessionId, "session-after-retry");
  assert.equal(attempts, 2);
  assert.equal(browserUseSessions.has("session-after-retry"), true);
});

test("browser sidecar inspection reports required Playwright availability", async () => {
  const controller = createBrokerBrowserController({
    docker: {
      getContainer() {
        return {
          inspect: async () => ({ State: { Running: true, Status: "running" } })
        };
      }
    },
    playwrightControlUrl: "http://playwright.test",
    playwrightArtifactsScratchDir: "/tmp/manor-playwright-artifacts",
    playwrightContainerName: "manor-playwright",
    previewNetwork: "manor_preview",
    sharedWorkNetwork: "manor_work",
    previewNetworkProbeTimeoutMs: 10,
    browserUseSessions: new Map(),
    hasBrokerAccess: () => true,
    requireContainer: async () => null,
    rejectIfLeaseRetainedFailed: () => false,
    rejectIfLeaseUnavailable: () => false,
    parseAliases: () => [],
    normalizeString: (value) => (typeof value === "string" ? value.trim() : ""),
    normalizePositiveInteger: () => null,
    normalizeEnv: () => ({}),
    normalizeCookieEntries: () => [],
    normalizeHeaderMap: () => ({}),
    resolveTargetHost: (containerName) => containerName,
    appendPreviewRoutePath: (baseUrl, routePath = "") => new URL(routePath.replace(/^\//, ""), baseUrl).toString(),
    persistVerificationArtifacts: async () => ({}),
    internalOperatorBaseUrl: "http://butler:8080",
    brokerToken: "broker-token",
    playwrightControlFetch: async () =>
      new Response(JSON.stringify({ ok: true, sessions: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });

  const status = await controller.inspectPlaywrightSidecar();

  assert.equal(status.required, true);
  assert.equal(status.available, true);
  assert.equal(status.message, "Playwright proof sidecar is ready.");
});

test("browser sidecar inspection reports stopped Playwright as unavailable", async () => {
  const controller = createBrokerBrowserController({
    docker: {
      getContainer() {
        return {
          inspect: async () => ({ State: { Running: false, Status: "exited" } })
        };
      }
    },
    playwrightControlUrl: "http://playwright.test",
    playwrightArtifactsScratchDir: "/tmp/manor-playwright-artifacts",
    playwrightContainerName: "manor-playwright",
    previewNetwork: "manor_preview",
    sharedWorkNetwork: "manor_work",
    previewNetworkProbeTimeoutMs: 10,
    browserUseSessions: new Map(),
    hasBrokerAccess: () => true,
    requireContainer: async () => null,
    rejectIfLeaseRetainedFailed: () => false,
    rejectIfLeaseUnavailable: () => false,
    parseAliases: () => [],
    normalizeString: (value) => (typeof value === "string" ? value.trim() : ""),
    normalizePositiveInteger: () => null,
    normalizeEnv: () => ({}),
    normalizeCookieEntries: () => [],
    normalizeHeaderMap: () => ({}),
    resolveTargetHost: (containerName) => containerName,
    appendPreviewRoutePath: (baseUrl, routePath = "") => new URL(routePath.replace(/^\//, ""), baseUrl).toString(),
    persistVerificationArtifacts: async () => ({}),
    internalOperatorBaseUrl: "http://butler:8080",
    brokerToken: "broker-token"
  });

  const status = await controller.inspectPlaywrightSidecar();

  assert.equal(status.required, true);
  assert.equal(status.available, false);
  assert.equal(status.status, "exited");
});
