#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { chromium } from "playwright";

const port = Number(process.env.MANOR_PLAYWRIGHT_PORT ?? "3777");
const sessionTtlMs = Number(process.env.MANOR_PLAYWRIGHT_SESSION_TTL_MS ?? `${30 * 60 * 1000}`);
const visualReadyTimeoutMs = Number(process.env.MANOR_PLAYWRIGHT_VISUAL_READY_TIMEOUT_MS ?? "15000");
const visualReadyPollIntervalMs = Number(process.env.MANOR_PLAYWRIGHT_VISUAL_READY_POLL_MS ?? "250");

const MAX_CAPTURED_CONSOLE_MESSAGES = 20;
const MAX_CAPTURED_PAGE_ERRORS = 12;
const MAX_CAPTURED_FAILED_REQUESTS = 20;
const RESOLUTION_PROFILES = {
  "1080p": { width: 1920, height: 1080 },
  "2k": { width: 2560, height: 1440 }
};

function now() {
  return Date.now();
}

function toErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function safeOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

function looksLikeStaticResource(resourceType, url) {
  if (resourceType === "image" || resourceType === "stylesheet" || resourceType === "font" || resourceType === "media") {
    return true;
  }

  if (resourceType === "script") {
    return true;
  }

  return /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)(?:\?|$)/i.test(url);
}

function hasQueryFlag(rawUrl, key) {
  try {
    return new URL(rawUrl).searchParams.has(key);
  } catch {
    return new RegExp(`[?&]${key}=`).test(rawUrl);
  }
}

function isIgnorableRequestFailure(resourceType, url, errorText) {
  if (hasQueryFlag(url, "_rsc")) {
    return true;
  }

  if (resourceType !== "document" && /(?:net::ERR_ABORTED|NS_BINDING_ABORTED)/i.test(errorText || "")) {
    return true;
  }

  return false;
}

function isIgnorableResponseError(resourceType, url) {
  if (hasQueryFlag(url, "_rsc")) {
    return true;
  }

  if (resourceType === "prefetch") {
    return true;
  }

  return false;
}

function detectHtmlErrorSignals(title, bodyText) {
  const signals = [];
  const normalized = `${title}\n${bodyText}`.toLowerCase();
  const candidates = [
    { pattern: /502 bad gateway/, label: "502 Bad Gateway" },
    { pattern: /504 gateway timeout/, label: "504 Gateway Timeout" },
    { pattern: /500 internal server error/, label: "500 Internal Server Error" },
    { pattern: /application error/, label: "Application error" },
    { pattern: /something went wrong/, label: "Something went wrong" },
    { pattern: /\b404\b.{0,40}\bnot found\b|\bnot found\b.{0,40}\b404\b/i, label: "404 Not Found" },
    { pattern: /directory listing for \//, label: "Directory listing" },
    { pattern: /index of \//, label: "Directory listing" },
    { pattern: /blocked request\. this host /, label: "Host allowlist blocked" }
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(normalized)) {
      signals.push(candidate.label);
    }
  }

  return [...new Set(signals)].slice(0, 8);
}

function createPhaseTracker() {
  const phases = [];

  return {
    phases,
    start(name, label) {
      const phase = {
        name,
        label,
        status: "active",
        startedAt: now(),
        completedAt: now(),
        durationMs: 0,
        message: null
      };
      phases.push(phase);
      return phase;
    },
    finish(phase, status, message = null) {
      phase.status = status;
      phase.completedAt = now();
      phase.durationMs = Math.max(0, phase.completedAt - phase.startedAt);
      phase.message = message && String(message).trim() ? String(message).trim() : null;
    }
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildArtifact(kind, label, filePath, contentType) {
  if (!filePath || !(await fileExists(filePath))) {
    return null;
  }

  const stats = await fs.stat(filePath);
  return {
    kind,
    label,
    fileName: path.basename(filePath),
    filePath,
    contentType,
    sizeBytes: stats.size,
    url: null
  };
}

async function collectArtifacts(descriptors) {
  const artifacts = [];
  for (const descriptor of descriptors) {
    const artifact = await buildArtifact(descriptor.kind, descriptor.label, descriptor.filePath, descriptor.contentType);
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function rankScreenshotArtifact(descriptor) {
  const label = typeof descriptor?.label === "string" ? descriptor.label.toLowerCase() : "";
  if (label.includes("final")) {
    return 0;
  }
  if (label.includes("after")) {
    return 1;
  }
  if (label.includes("ready")) {
    return 2;
  }
  return 3;
}

function classifyFailure(input) {
  if (input.ok) {
    return "none";
  }

  if (input.failedPhase === "action") {
    return "script";
  }

  if (input.status !== null && input.status >= 400) {
    if (input.status === 403 && input.htmlErrorSignals.includes("Host allowlist blocked")) {
      return "readiness";
    }
    if (input.status === 401 || input.status === 403 || input.loginRedirectDetected) {
      return "auth";
    }
    return "http";
  }

  if (input.loginRedirectDetected) {
    return "auth";
  }

  if (input.selectorExpected && input.selectorSatisfied === false) {
    return "readiness";
  }

  if (input.noVisualContent) {
    return "readiness";
  }

  if (input.sameOriginAssetFailureCount > 0 || input.htmlErrorSignals.length > 0) {
    return "readiness";
  }

  if (input.captureMissing) {
    return "artifact";
  }

  if (input.failedPhase === "await_ready") {
    return "readiness";
  }

  return input.error ? "unknown" : "preview";
}

function normalizeStage(input, fallbackName) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : fallbackName;
  const ok =
    input.ok === null || typeof input.ok === "boolean"
      ? input.ok
      : input.ok === "true"
        ? true
        : input.ok === "false"
          ? false
          : null;
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  const status = typeof input.status === "number" && Number.isFinite(input.status) ? Math.trunc(input.status) : null;
  const hint = typeof input.hint === "string" && input.hint.trim() ? input.hint.trim() : null;
  const failureKind = typeof input.failureKind === "string" && input.failureKind.trim() ? input.failureKind.trim() : null;
  return {
    name,
    ok,
    detail,
    status,
    hint,
    failureKind
  };
}

function normalizePreflightStages(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return {
    processUp: normalizeStage(input.processUp, "process_up"),
    networkReachable: normalizeStage(input.networkReachable, "network_reachable"),
    routeAuth: normalizeStage(input.routeAuth, "route_auth")
  };
}

function createDiagnosticStage(name, ok, detail, options = {}) {
  return {
    name,
    ok: ok === null ? null : ok === true,
    detail: typeof detail === "string" ? detail.trim() : "",
    status: typeof options.status === "number" && Number.isFinite(options.status) ? Math.trunc(options.status) : null,
    hint: typeof options.hint === "string" && options.hint.trim() ? options.hint.trim() : null,
    failureKind:
      typeof options.failureKind === "string" && options.failureKind.trim() ? options.failureKind.trim() : null
  };
}

function buildRemediationHints(input) {
  const hints = [];
  if (input.preflightStages?.networkReachable?.ok === false && input.preflightStages.networkReachable.hint) {
    hints.push(input.preflightStages.networkReachable.hint);
  }
  if (input.failureKind === "auth") {
    hints.push("Provide valid session cookies or auth headers for protected routes.");
  }
  if (input.failureKind === "http" && input.status && input.status >= 500) {
    hints.push("Check preview logs for backend/runtime errors before retrying browser smoke.");
  }
  if (input.failureKind === "readiness" && input.selectorExpected && input.selectorSatisfied === false) {
    hints.push(`Wait for selector ${input.selectorExpected} or verify the selector is still correct.`);
  }
  if (input.failureKind === "readiness" && input.htmlErrorSignals.includes("Host allowlist blocked")) {
    hints.push("Run the dev server with host binding enabled (for example --host 0.0.0.0).");
  }
  if (input.failureKind === "readiness" && input.noVisualContent) {
    hints.push("Page loaded but no visible UI rendered; provide --wait-for with a stable selector or fix frontend runtime errors.");
  }
  if (
    input.failureKind === "readiness" &&
    Array.isArray(input.consoleMessages) &&
    input.consoleMessages.some((entry) =>
      /Failed to load module script|Unexpected token '<'|ReferenceError|TypeError|Cannot find module/i.test(
        String(entry?.text || "")
      )
    )
  ) {
    hints.push("Resolve client-side script/module errors surfaced in console output before rerunning proof.");
  }
  if (input.failureKind === "script") {
    hints.push("Review the failed browser action script and rerun the session.");
  }
  if (input.failureKind === "artifact") {
    hints.push("Retry with stable browser startup; required proof artifacts were missing.");
  }
  return [...new Set(hints)].filter(Boolean);
}

async function collectVisualSignals(page) {
  return page
    .evaluate(() => {
      const parseOpacity = (value) => {
        const parsed = Number.parseFloat(value || "1");
        return Number.isFinite(parsed) ? parsed : 1;
      };
      const isVisibleBox = (element) => {
        const style = window.getComputedStyle(element);
        if (!style) {
          return false;
        }
        if (style.display === "none" || style.visibility === "hidden" || parseOpacity(style.opacity) <= 0.01) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };

      const body = document.body;
      if (!body) {
        return {
          bodyVisible: false,
          bodyTextLength: 0,
          visibleElementCount: 0,
          mediaElementCount: 0,
          rootChildCount: 0,
          ready: false
        };
      }

      const bodyVisible = isVisibleBox(body);
      const bodyTextLength = (body.innerText || "").replace(/\s+/g, " ").trim().length;
      const mediaElementCount = body.querySelectorAll("img,svg,canvas,video,iframe").length;
      const root = document.querySelector("#root, #app, main, [role='main'], [data-testid='app']");
      const rootChildCount = root ? root.childElementCount : 0;

      let visibleElementCount = 0;
      const candidates = body.querySelectorAll("*");
      for (const element of candidates) {
        if (isVisibleBox(element)) {
          visibleElementCount += 1;
          if (visibleElementCount >= 25) {
            break;
          }
        }
      }

      const ready =
        bodyVisible &&
        (bodyTextLength >= 20 || visibleElementCount > 0 || rootChildCount > 0 || mediaElementCount > 0);

      return {
        bodyVisible,
        bodyTextLength,
        visibleElementCount,
        mediaElementCount,
        rootChildCount,
        ready
      };
    })
    .catch(() => ({
      bodyVisible: false,
      bodyTextLength: 0,
      visibleElementCount: 0,
      mediaElementCount: 0,
      rootChildCount: 0,
      ready: false
    }));
}

async function waitForVisualReadiness(page, timeoutMs) {
  const deadline = now() + Math.max(500, timeoutMs);
  let lastSignals = await collectVisualSignals(page);
  if (lastSignals.ready) {
    return { ready: true, signals: lastSignals };
  }

  while (now() < deadline) {
    await page.waitForTimeout(Math.max(50, visualReadyPollIntervalMs));
    lastSignals = await collectVisualSignals(page);
    if (lastSignals.ready) {
      return { ready: true, signals: lastSignals };
    }
  }

  return { ready: false, signals: lastSignals };
}

function normalizeHeaders(input) {
  if (!input || typeof input !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0)
  );
}

function normalizeCookies(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      value: typeof entry.value === "string" ? entry.value : ""
    }))
    .filter((entry) => entry.name.length > 0);
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const sessions = new Map();

function normalizeResolution(value) {
  const requested = typeof value === "string" ? value.trim().toLowerCase() : "";
  const name = requested === "2k" || requested === "1440p" ? "2k" : "1080p";
  return { name, viewport: RESOLUTION_PROFILES[name] };
}

function sessionSummary(session) {
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    mode: session.mode,
    targetUrl: session.targetUrl,
    outputDir: session.outputDir,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    status: session.status,
    title: session.title,
    url: session.url,
    resolution: session.resolution,
    viewport: session.viewport,
    actionCount: session.actions.length,
    auth: {
      headerCount: Object.keys(session.headers).length,
      cookieCount: session.cookies.length,
      cookieNames: session.cookies.map((entry) => entry.name),
      usedSessionCookie: session.cookies.some((entry) => entry.name === "better-auth.session_token")
    }
  };
}

async function captureScreenshot(session, fileName, label) {
  if (!session.page || session.page.isClosed()) {
    return;
  }

  const filePath = path.join(session.outputDir, fileName);
  const captured = await session.page.screenshot({ path: filePath, fullPage: true }).then(() => true).catch(() => false);
  if (!captured) {
    return;
  }

  session.screenshotArtifacts.push({
    kind: "screenshot",
    label,
    filePath,
    contentType: "image/png"
  });
}

function attachPageObservers(session) {
  session.page.on("console", (message) => {
    session.consoleMessageCount += 1;
    if (session.consoleMessages.length >= MAX_CAPTURED_CONSOLE_MESSAGES) {
      return;
    }

    const location = message.location();
    const locationText =
      location && typeof location.url === "string" && location.url
        ? `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`
        : null;

    session.consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: locationText
    });
  });

  session.page.on("pageerror", (error) => {
    session.pageErrorCount += 1;
    if (session.pageErrors.length >= MAX_CAPTURED_PAGE_ERRORS) {
      return;
    }
    session.pageErrors.push(toErrorMessage(error));
  });

  session.page.on("requestfailed", (request) => {
    const failure = request.failure();
    const resourceType = request.resourceType();
    const requestUrl = request.url();
    const errorText = failure?.errorText ?? null;
    if (isIgnorableRequestFailure(resourceType, requestUrl, errorText)) {
      return;
    }

    session.failedRequestCount += 1;
    if (safeOrigin(requestUrl) === session.targetOrigin && looksLikeStaticResource(resourceType, requestUrl)) {
      session.sameOriginAssetFailureCount += 1;
    }

    if (session.failedRequests.length >= MAX_CAPTURED_FAILED_REQUESTS) {
      return;
    }

    session.failedRequests.push({
      url: requestUrl,
      method: request.method(),
      errorText
    });
  });

  session.page.on("response", (response) => {
    const responseStatus = response.status();
    if (responseStatus < 400) {
      return;
    }

    const request = response.request();
    const requestUrl = request.url();
    const resourceType = request.resourceType();
    if (isIgnorableResponseError(resourceType, requestUrl)) {
      return;
    }

    session.responseErrorCount += 1;
    if (safeOrigin(requestUrl) === session.targetOrigin && looksLikeStaticResource(resourceType, requestUrl)) {
      session.sameOriginAssetFailureCount += 1;
    }
  });
}

function humanizeActionType(type) {
  return String(type || "")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase();
}

function formatAutoCaptureLabel(session, type) {
  const actionNumber = session.actions.length + 1;
  return `After ${humanizeActionType(type)} ${actionNumber}`;
}

async function cleanupFailedSession(session, error) {
  session.error = toErrorMessage(error);
  if (!session.failedPhase) {
    const activePhase = [...session.phaseTracker.phases].reverse().find((phase) => phase.status === "active");
    session.failedPhase = activePhase?.name ?? "startup";
    if (activePhase) {
      session.phaseTracker.finish(activePhase, "failed", session.error);
    }
  }

  if (session.context && session.tracingEnabled) {
    await session.context.tracing.stop({ path: session.tracePath }).catch(() => undefined);
  }
  if (session.screencastEnabled && session.page?.screencast && typeof session.page.screencast.stop === "function") {
    await session.page.screencast.stop().catch(() => undefined);
  }
  if (session.page && !session.page.isClosed()) {
    await session.page.close().catch(() => undefined);
  }
  if (session.context) {
    await session.context.close().catch(() => undefined);
  }
  if (session.browser) {
    await session.browser.close().catch(() => undefined);
  }
  sessions.delete(session.sessionId);
}

async function startSession(input) {
  const targetUrl = typeof input.targetUrl === "string" ? input.targetUrl.trim() : "";
  const outputDir = typeof input.outputDir === "string" ? input.outputDir.trim() : "";
  if (!targetUrl || !outputDir) {
    throw new Error("targetUrl and outputDir are required");
  }

  const mode = input.mode === "headful" ? "headful" : "headless";
  const runId = typeof input.runId === "string" && input.runId.trim() ? input.runId.trim() : `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : randomUUID();
  const waitForSelector = typeof input.waitForSelector === "string" ? input.waitForSelector.trim() : "";
  const resolution = normalizeResolution(input.resolution);
  const postLoadWaitMs =
    typeof input.postLoadWaitMs === "number" && Number.isFinite(input.postLoadWaitMs)
      ? Math.max(0, Math.trunc(input.postLoadWaitMs))
      : 0;
  const headers = normalizeHeaders(input.headers);
  const cookies = normalizeCookies(input.cookies);
  const preflightStages = normalizePreflightStages(input.preflightStages);

  const startedAt = now();
  await fs.mkdir(outputDir, { recursive: true });

  const phaseTracker = createPhaseTracker();
  const launchPhase = phaseTracker.start("launch_browser", "Launch browser");
  const browser = await chromium.launch({ headless: mode === "headless" });
  phaseTracker.finish(launchPhase, "completed", mode === "headful" ? "Headed browser launched." : "Headless browser launched.");

  const contextPhase = phaseTracker.start("create_context", "Create context");
  const context = await browser.newContext({
    viewport: resolution.viewport
  });
  context.setDefaultNavigationTimeout(45_000);
  context.setDefaultTimeout(15_000);
  if (Object.keys(headers).length > 0) {
    await context.setExtraHTTPHeaders(headers);
  }
  if (cookies.length > 0) {
    await context.addCookies(
      cookies.map((entry) => ({
        name: entry.name,
        value: entry.value,
        url: targetUrl
      }))
    );
  }
  phaseTracker.finish(contextPhase, "completed", `Headers=${Object.keys(headers).length}. Cookies=${cookies.length}.`);

  const page = await context.newPage();
  const videoPath = path.join(outputDir, "video.webm");

  const session = {
    sessionId,
    runId,
    mode,
    targetUrl,
    outputDir,
    waitForSelector,
    postLoadWaitMs,
    headers,
    cookies,
    startedAt,
    lastActivityAt: startedAt,
    title: "",
    url: targetUrl,
    status: null,
    resolution: resolution.name,
    viewport: resolution.viewport,
    actions: [],
    browser,
    context,
    page,
    screencastEnabled: false,
    tracingEnabled: false,
    targetOrigin: safeOrigin(targetUrl),
    phaseTracker,
    screenshotArtifacts: [],
    manifestPath: path.join(outputDir, "manifest.json"),
    htmlPath: path.join(outputDir, "page.html"),
    tracePath: path.join(outputDir, "trace.zip"),
    videoPath,
    error: null,
    failedPhase: null,
    selectorSatisfied: waitForSelector ? false : null,
    consoleMessages: [],
    pageErrors: [],
    failedRequests: [],
    consoleMessageCount: 0,
    pageErrorCount: 0,
    failedRequestCount: 0,
    responseErrorCount: 0,
    sameOriginAssetFailureCount: 0,
    preflightStages,
    visualContentDetected: null,
    visualSignals: null
  };

  try {
    sessions.set(sessionId, session);

    const screencastPhase = phaseTracker.start("start_screencast", "Start screencast");
    if (!page.screencast || typeof page.screencast.start !== "function" || typeof page.screencast.showActions !== "function") {
      throw new Error("Playwright screencast API is unavailable.");
    }
    await page.screencast.start({ path: videoPath, size: resolution.viewport });
    await page.screencast.showActions({ position: "top-right" });
    session.screencastEnabled = true;
    phaseTracker.finish(screencastPhase, "completed", "Native action annotations enabled.");

    const tracingPhase = phaseTracker.start("start_trace", "Start trace");
    await context.tracing.start({ screenshots: true, snapshots: true });
    session.tracingEnabled = true;
    phaseTracker.finish(tracingPhase, "completed", "Trace capture enabled after video sizing.");

    attachPageObservers(session);

    const openPhase = phaseTracker.start("open_page", "Open page");
    const response = await page.goto(targetUrl, { waitUntil: "load", timeout: 45_000 });
    session.status = response?.status() ?? null;
    phaseTracker.finish(openPhase, "completed", session.status === null ? "No response status was reported." : `HTTP ${session.status}.`);

    const readyPhase = phaseTracker.start("await_ready", "Wait for ready");
    await page.locator("body").first().waitFor({ state: "attached", timeout: 45_000 });
    if (waitForSelector) {
      await page.locator(waitForSelector).first().waitFor({ state: "visible", timeout: 45_000 });
      session.selectorSatisfied = true;
      session.visualContentDetected = true;
      session.visualSignals = {
        bodyVisible: true,
        bodyTextLength: 0,
        visibleElementCount: 1,
        mediaElementCount: 0,
        rootChildCount: 0,
        ready: true
      };
    }
    if (postLoadWaitMs > 0) {
      await page.waitForTimeout(postLoadWaitMs);
    }
    if (!waitForSelector) {
      const visual = await waitForVisualReadiness(page, visualReadyTimeoutMs);
      session.visualContentDetected = visual.ready;
      session.visualSignals = visual.signals;
    }
    phaseTracker.finish(
      readyPhase,
      "completed",
      waitForSelector
        ? `Locator ready: ${waitForSelector}`
        : session.visualContentDetected
          ? "Page loaded and visible UI content detected."
          : "Page loaded but no visible UI content was detected."
    );

    session.title = await page.title().catch(() => "");
    session.url = page.url() || targetUrl;

    await captureScreenshot(session, "ready.png", "Ready screenshot");
  } catch (error) {
    await cleanupFailedSession(session, error);
    throw error;
  }

  return sessionSummary(session);
}

async function runAction(session, input) {
  const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  if (!type) {
    throw new Error("Action type is required");
  }

  const startedAt = now();
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(250, Math.trunc(input.timeoutMs))
      : undefined;
  const actionLabel = `${type}${typeof input.selector === "string" && input.selector.trim() ? ` ${input.selector.trim()}` : ""}`;
  const phase = session.phaseTracker.start("action", actionLabel);

  try {
    if (type === "click") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error("click requires selector");
      }
      await session.page.locator(selector).first().click(timeoutMs ? { timeout: timeoutMs } : undefined);
    } else if (type === "fill") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error("fill requires selector");
      }
      await session.page.locator(selector).first().fill(String(input.value ?? ""), timeoutMs ? { timeout: timeoutMs } : undefined);
    } else if (type === "type") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error("type requires selector");
      }
      const delay =
        typeof input.delayMs === "number" && Number.isFinite(input.delayMs)
          ? Math.max(0, Math.trunc(input.delayMs))
          : undefined;
      await session.page.locator(selector).first().type(String(input.text ?? ""), {
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
        ...(delay !== undefined ? { delay } : {})
      });
    } else if (type === "press") {
      const key = String(input.key || "").trim();
      if (!key) {
        throw new Error("press requires key");
      }
      const selector = String(input.selector || "").trim();
      if (selector) {
        await session.page.locator(selector).first().press(key, timeoutMs ? { timeout: timeoutMs } : undefined);
      } else {
        await session.page.keyboard.press(key);
      }
    } else if (type === "hover") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error("hover requires selector");
      }
      await session.page.locator(selector).first().hover(timeoutMs ? { timeout: timeoutMs } : undefined);
    } else if (type === "select") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error("select requires selector");
      }
      const values = Array.isArray(input.values)
        ? input.values.map((entry) => String(entry)).filter(Boolean)
        : String(input.value || "").trim()
          ? [String(input.value).trim()]
          : [];
      if (values.length === 0) {
        throw new Error("select requires value or values");
      }
      await session.page.locator(selector).first().selectOption(values, timeoutMs ? { timeout: timeoutMs } : undefined);
    } else if (type === "check" || type === "uncheck") {
      const selector = String(input.selector || "").trim();
      if (!selector) {
        throw new Error(`${type} requires selector`);
      }
      if (type === "check") {
        await session.page.locator(selector).first().check(timeoutMs ? { timeout: timeoutMs } : undefined);
      } else {
        await session.page.locator(selector).first().uncheck(timeoutMs ? { timeout: timeoutMs } : undefined);
      }
    } else if (type === "scroll") {
      const selector = String(input.selector || "").trim();
      const x = typeof input.x === "number" && Number.isFinite(input.x) ? input.x : 0;
      const y = typeof input.y === "number" && Number.isFinite(input.y) ? input.y : 0;
      if (selector) {
        await session.page.locator(selector).first().evaluate((element, payload) => {
          element.scrollBy(payload.x, payload.y);
        }, { x, y });
      } else {
        await session.page.mouse.wheel(x, y);
      }
    } else if (type === "wait_for") {
      const ms = typeof input.ms === "number" && Number.isFinite(input.ms) ? Math.max(0, Math.trunc(input.ms)) : 0;
      const selector = String(input.selector || "").trim();
      const urlIncludes = String(input.urlIncludes || "").trim();
      if (selector) {
        await session.page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs ?? 45_000 });
      }
      if (urlIncludes) {
        await session.page.waitForURL((url) => url.toString().includes(urlIncludes), { timeout: timeoutMs ?? 45_000 });
      }
      if (ms > 0) {
        await session.page.waitForTimeout(ms);
      }
    } else if (type === "navigate") {
      const url = String(input.url || "").trim();
      if (!url) {
        throw new Error("navigate requires url");
      }
      const response = await session.page.goto(url, { waitUntil: "load", timeout: timeoutMs ?? 45_000 });
      session.status = response?.status() ?? session.status;
    } else if (type === "evaluate") {
      const script = String(input.script || "").trim();
      if (!script) {
        throw new Error("evaluate requires script");
      }
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const runner = new AsyncFunction("page", "context", "browser", "chromium", "session", script);
      await runner(
        session.page,
        session.context,
        session.browser,
        chromium,
        Object.freeze({
          sessionId: session.sessionId,
          runId: session.runId,
          targetUrl: session.targetUrl,
          outputDir: session.outputDir
        })
      );
    } else if (type === "screenshot") {
      const label = String(input.label || "Custom screenshot").trim() || "Custom screenshot";
      const fileName = String(input.fileName || `${now()}-shot.png`).trim() || `${now()}-shot.png`;
      await captureScreenshot(session, fileName, label);
    } else {
      throw new Error(`Unsupported action type: ${type}`);
    }

    session.title = await session.page.title().catch(() => session.title);
    session.url = session.page.url() || session.url;
    session.lastActivityAt = now();

    const autoCapture = input.autoCapture !== false;
    if (autoCapture && type !== "screenshot") {
      await captureScreenshot(session, `${now()}-${type}.png`, formatAutoCaptureLabel(session, type));
    }

    session.actions.push({
      type,
      at: now(),
      durationMs: Math.max(0, now() - startedAt),
      status: "completed"
    });

    session.phaseTracker.finish(phase, "completed", `Action completed: ${type}`);

    return {
      ok: true,
      action: {
        type,
        durationMs: Math.max(0, now() - startedAt)
      },
      state: {
        title: session.title,
        url: session.url,
        status: session.status,
        resolution: session.resolution,
        viewport: session.viewport,
        actionCount: session.actions.length
      }
    };
  } catch (error) {
    const message = toErrorMessage(error);
    session.error = message;
    session.failedPhase = "action";
    session.actions.push({
      type,
      at: now(),
      durationMs: Math.max(0, now() - startedAt),
      status: "failed",
      error: message
    });
    session.phaseTracker.finish(phase, "failed", message);
    throw error;
  }
}

async function stopSession(session, reason = "completed") {
  const capturePhase = session.phaseTracker.start("capture_artifacts", "Capture artifacts");

  try {
    await captureScreenshot(session, "final.png", "Final screenshot");

    if (session.page && !session.page.isClosed()) {
      const html = await session.page.content().catch(() => "");
      if (html) {
        await fs.writeFile(session.htmlPath, html, "utf8");
      }
    }

    if (session.context && session.tracingEnabled) {
      await session.context.tracing.stop({ path: session.tracePath }).catch(() => undefined);
    }

    if (session.screencastEnabled && session.page?.screencast && typeof session.page.screencast.stop === "function") {
      await session.page.screencast.stop().catch(() => undefined);
    }

    if (session.page && !session.page.isClosed()) {
      await session.page.close().catch(() => undefined);
    }

    session.phaseTracker.finish(capturePhase, "completed", "Screenshots, HTML, trace, and video capture attempted.");
  } catch (error) {
    session.phaseTracker.finish(capturePhase, "failed", toErrorMessage(error));
  }

  if (session.context) {
    await session.context.close().catch(() => undefined);
  }

  if (session.browser) {
    await session.browser.close().catch(() => undefined);
  }

  const checkedAt = now();
  const orderedScreenshots = [...session.screenshotArtifacts].sort((left, right) => {
    const delta = rankScreenshotArtifact(left) - rankScreenshotArtifact(right);
    if (delta !== 0) {
      return delta;
    }
    return left.label.localeCompare(right.label);
  });

  let htmlSignals = { titleText: "", bodyText: "" };
  if (await fileExists(session.htmlPath)) {
    const html = await fs.readFile(session.htmlPath, "utf8").catch(() => "");
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    htmlSignals = {
      titleText: titleMatch?.[1]?.trim() || session.title || "",
      bodyText: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000)
    };
  }

  const htmlErrorSignals = detectHtmlErrorSignals(htmlSignals.titleText || session.title, htmlSignals.bodyText);
  const expectedPath = (() => {
    try {
      return new URL(session.targetUrl).pathname || "/";
    } catch {
      return null;
    }
  })();
  const loginRedirectDetected =
    !/\/(?:login|sign-?in|auth)\b/i.test(expectedPath || "") && /\/(?:login|sign-?in|auth)\b/i.test(session.url || "");

  const actionFailed = session.actions.some((entry) => entry.status === "failed");
  const baseOk =
    session.error === null &&
    !actionFailed &&
    (session.status === null || session.status < 400) &&
    !loginRedirectDetected;

  const artifacts = await collectArtifacts([
    {
      kind: "manifest",
      label: "Manifest",
      filePath: session.manifestPath,
      contentType: "application/json"
    },
    ...orderedScreenshots,
    {
      kind: "html",
      label: "Rendered HTML",
      filePath: session.htmlPath,
      contentType: "text/html; charset=utf-8"
    },
    {
      kind: "trace",
      label: "Playwright trace",
      filePath: session.tracePath,
      contentType: "application/zip"
    },
    {
      kind: "video",
      label: "Video",
      filePath: session.videoPath,
      contentType: "video/webm"
    }
  ]);

  const captureMissing = !artifacts.some((artifact) => artifact.kind === "screenshot") || !artifacts.some((artifact) => artifact.kind === "trace");
  const noVisualContent = !session.waitForSelector && session.visualContentDetected === false;
  const error = session.error || (captureMissing ? "Required proof artifacts were not captured." : null);
  const ok = baseOk && !captureMissing && !noVisualContent;

  const failureKind = classifyFailure({
    ok,
    error,
    status: session.status,
    failedPhase: session.failedPhase,
    selectorExpected: Boolean(session.waitForSelector),
    selectorSatisfied: session.selectorSatisfied,
    sameOriginAssetFailureCount: session.sameOriginAssetFailureCount,
    htmlErrorSignals,
    loginRedirectDetected,
    captureMissing,
    noVisualContent
  });

  const uiSelectorStage = createDiagnosticStage(
    "ui_selector_visible",
    session.waitForSelector ? session.selectorSatisfied !== false : session.visualContentDetected !== false,
    session.waitForSelector
      ? session.selectorSatisfied === true
        ? `Selector became visible: ${session.waitForSelector}`
        : `Selector was not satisfied: ${session.waitForSelector}`
      : session.visualContentDetected === false
        ? "No visible UI content was detected."
        : "Visible UI content was detected without a selector requirement.",
    {
      failureKind:
        (session.waitForSelector && session.selectorSatisfied === false) || (!session.waitForSelector && noVisualContent)
          ? "readiness"
          : null
    }
  );

  const remediationHints = buildRemediationHints({
    preflightStages: session.preflightStages,
    failureKind,
    status: session.status,
    selectorExpected: session.waitForSelector || null,
    selectorSatisfied: session.selectorSatisfied,
    htmlErrorSignals,
    noVisualContent,
    consoleMessages: session.consoleMessages
  });

  const result = {
    runId: session.runId,
    mode: session.mode,
    checkedAt,
    durationMs: checkedAt - session.startedAt,
    ok,
    status: session.status,
    title: session.title,
    url: session.url,
    resolution: session.resolution,
    viewport: session.viewport,
    error,
    failureKind,
    summary: {
      consoleMessageCount: session.consoleMessageCount,
      pageErrorCount: session.pageErrorCount,
      failedRequestCount: session.failedRequestCount,
      responseErrorCount: session.responseErrorCount,
      assetFailureCount: session.sameOriginAssetFailureCount,
      phaseCount: session.phaseTracker.phases.length,
      actionCount: session.actions.length
    },
    phases: session.phaseTracker.phases,
    readiness: {
      initialUrl: session.targetUrl,
      finalUrl: session.url,
      expectedPath,
      selector: session.waitForSelector || null,
      selectorSatisfied: session.selectorSatisfied,
      routeStatus: session.status,
      routeOk: session.status !== null ? session.status < 400 : ok,
      loginRedirectDetected,
      visualContentDetected: session.visualContentDetected,
      visualSignals: session.visualSignals,
      htmlErrorSignals,
      sameOriginAssetFailureCount: session.sameOriginAssetFailureCount,
      websocketFailureCount: 0,
      notes: [
        reason ? `Session closed: ${reason}.` : "",
        session.failedPhase ? `Failed phase: ${session.failedPhase}.` : ""
      ].filter(Boolean)
    },
    auth: {
      headerCount: Object.keys(session.headers).length,
      cookieCount: session.cookies.length,
      cookieNames: session.cookies.map((entry) => entry.name),
      usedSessionCookie: session.cookies.some((entry) => entry.name === "better-auth.session_token")
    },
    diagnostics: {
      stages: {
        processUp: session.preflightStages?.processUp ?? null,
        networkReachable: session.preflightStages?.networkReachable ?? null,
        routeAuth: session.preflightStages?.routeAuth ?? null,
        uiSelectorVisible: uiSelectorStage
      },
      remediationHints
    },
    actions: session.actions,
    artifacts,
    consoleMessages: session.consoleMessages,
    pageErrors: session.pageErrors,
    failedRequests: session.failedRequests
  };

  await fs.writeFile(session.manifestPath, JSON.stringify(result, null, 2));
  sessions.delete(session.sessionId);
  return result;
}

async function closeExpiredSessions() {
  const cutoff = now() - sessionTtlMs;
  const expired = [...sessions.values()].filter((session) => session.lastActivityAt < cutoff);
  for (const session of expired) {
    await stopSession(session, "expired").catch(() => undefined);
  }
}

setInterval(() => {
  void closeExpiredSessions();
}, 60_000);

const server = http.createServer(async (request, response) => {
  try {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);

    if (method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, sessions: sessions.size });
      return;
    }

    if (method === "POST" && url.pathname === "/sessions") {
      const payload = await parseJsonBody(request);
      const summary = await startSession(payload);
      writeJson(response, 200, { ok: true, session: summary });
      return;
    }

    const stateMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (stateMatch && method === "GET") {
      const session = sessions.get(stateMatch[1]);
      if (!session) {
        writeJson(response, 404, { error: "Session not found" });
        return;
      }
      writeJson(response, 200, { ok: true, session: sessionSummary(session) });
      return;
    }

    const actionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/actions$/);
    if (actionMatch && method === "POST") {
      const session = sessions.get(actionMatch[1]);
      if (!session) {
        writeJson(response, 404, { error: "Session not found" });
        return;
      }
      const payload = await parseJsonBody(request);
      const result = await runAction(session, payload);
      writeJson(response, 200, result);
      return;
    }

    const stopMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (stopMatch && method === "DELETE") {
      const session = sessions.get(stopMatch[1]);
      if (!session) {
        writeJson(response, 404, { error: "Session not found" });
        return;
      }
      const payload = await parseJsonBody(request).catch(() => ({}));
      const reason = typeof payload.reason === "string" ? payload.reason : "completed";
      const result = await stopSession(session, reason);
      writeJson(response, 200, { ok: true, verification: result });
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    writeJson(response, 500, { error: toErrorMessage(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Playwright browser-use server listening on ${port}`);
});
