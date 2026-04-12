#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const MAX_CAPTURED_CONSOLE_MESSAGES = 12;
const MAX_CAPTURED_PAGE_ERRORS = 8;
const MAX_CAPTURED_FAILED_REQUESTS = 12;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function toErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function buildLocation(location) {
  if (!location || typeof location !== "object") {
    return null;
  }

  const url = typeof location.url === "string" ? location.url : "";
  const lineNumber = typeof location.lineNumber === "number" ? location.lineNumber : null;
  const columnNumber = typeof location.columnNumber === "number" ? location.columnNumber : null;
  if (!url) {
    return null;
  }

  if (lineNumber === null || columnNumber === null) {
    return url;
  }

  return `${url}:${lineNumber}:${columnNumber}`;
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
    { pattern: /index of \//, label: "Directory listing" }
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(normalized)) {
      signals.push(candidate.label);
    }
  }

  return [...new Set(signals)].slice(0, 5);
}

function createPhaseTracker() {
  const phases = [];

  return {
    phases,
    start(name, label) {
      const phase = {
        name,
        label,
        status: "completed",
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        message: null
      };
      phases.push(phase);
      return phase;
    },
    finish(phase, status, message = null) {
      phase.status = status;
      phase.completedAt = Date.now();
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
  if (!(await fileExists(filePath))) {
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

async function collectArtifacts(paths) {
  const artifacts = [];
  for (const descriptor of paths) {
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
  if (label.includes("after script")) {
    return 1;
  }
  if (label.includes("ready")) {
    return 2;
  }
  return 3;
}

function parseLiveCheckResultError(errorText) {
  if (typeof errorText !== "string" || !errorText.includes("LIVE_CHECK_RESULT")) {
    return null;
  }

  const match = errorText.match(/LIVE_CHECK_RESULT\s+(\{[\s\S]*?\})(?:\n|$)/);
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseLiveCheckRequestFailure(entry) {
  if (typeof entry !== "string") {
    return null;
  }

  const match = entry.match(/^(?<method>[A-Z]+)\s+(?<url>\S+)\s+::\s+(?<errorText>.+)$/);
  if (!match?.groups?.url) {
    return null;
  }

  return {
    method: match.groups.method || "GET",
    url: match.groups.url,
    errorText: match.groups.errorText || ""
  };
}

function isBenignLiveCheckResult(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const consoleErrors = Array.isArray(payload.consoleErrors) ? payload.consoleErrors.filter(Boolean) : [];
  const pageErrors = Array.isArray(payload.pageErrors) ? payload.pageErrors.filter(Boolean) : [];
  const requestFailures = Array.isArray(payload.requestFailures) ? payload.requestFailures : [];
  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    return false;
  }

  return requestFailures.every((entry) => {
    const parsed = parseLiveCheckRequestFailure(entry);
    if (!parsed) {
      return false;
    }
    return isIgnorableRequestFailure("fetch", parsed.url, parsed.errorText);
  });
}

function isVerifierScriptFailure(errorText) {
  if (typeof errorText !== "string") {
    return false;
  }

  return (
    /SyntaxError:/i.test(errorText) ||
    /Identifier ['"`].+['"`] has already been declared/.test(errorText) ||
    /Unexpected (?:token|identifier|end of input)/i.test(errorText)
  );
}

function classifyFailure(input) {
  if (input.ok) {
    return "none";
  }

  if (input.failedPhase === "run_script") {
    if (input.verifierScriptFailure) {
      return "verifier";
    }
    return "script";
  }

  if (input.failedPhase === "open_page" && /(net::|econnrefused|eai_again|enotfound|timed out|timeout)/i.test(input.error || "")) {
    return "preview";
  }

  if (input.status !== null && input.status >= 400) {
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

async function run() {
  const rawOptions = process.argv[2];
  if (!rawOptions) {
    throw new Error("Missing verification options");
  }

  const options = JSON.parse(rawOptions);
  const targetUrl = typeof options.targetUrl === "string" ? options.targetUrl : "";
  const outputDir = typeof options.outputDir === "string" ? options.outputDir : "";
  const mode = options.mode === "headful" ? "headful" : "headless";
  const waitForSelector = typeof options.waitForSelector === "string" ? options.waitForSelector.trim() : "";
  const postLoadWaitMs =
    typeof options.postLoadWaitMs === "number" && Number.isFinite(options.postLoadWaitMs)
      ? Math.max(0, Math.trunc(options.postLoadWaitMs))
      : 0;
  const headers =
    options.headers && typeof options.headers === "object"
      ? Object.fromEntries(
          Object.entries(options.headers)
            .filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([key, value]) => [key.trim(), value.trim()])
            .filter(([key, value]) => key.length > 0 && value.length > 0)
        )
      : {};
  const cookies = Array.isArray(options.cookies)
    ? options.cookies
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          name: typeof entry.name === "string" ? entry.name.trim() : "",
          value: typeof entry.value === "string" ? entry.value : ""
        }))
        .filter((entry) => entry.name.length > 0)
    : [];
  const script = typeof options.script === "string" ? options.script.trim() : "";
  if (!targetUrl || !outputDir) {
    throw new Error("targetUrl and outputDir are required");
  }

  const runId = typeof options.runId === "string" && options.runId ? options.runId : path.basename(outputDir) || randomUUID();
  await fs.mkdir(outputDir, { recursive: true });

  const startedAt = Date.now();
  const manifestPath = path.join(outputDir, "manifest.json");
  const htmlPath = path.join(outputDir, "page.html");
  const tracePath = path.join(outputDir, "trace.zip");
  const screenshotArtifacts = [];
  let videoPath = null;

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  let consoleMessageCount = 0;
  let pageErrorCount = 0;
  let failedRequestCount = 0;
  let responseErrorCount = 0;
  let sameOriginAssetFailureCount = 0;
  let websocketFailureCount = 0;
  let status = null;
  let title = "";
  let finalUrl = targetUrl;
  let error = null;
  let ok = false;
  let failedPhase = null;
  let selectorSatisfied = waitForSelector ? false : null;
  let htmlErrorSignals = [];
  let liveCheckResult = null;

  const phaseTracker = createPhaseTracker();
  const targetOrigin = safeOrigin(targetUrl);
  const expectedPath = (() => {
    try {
      return new URL(targetUrl).pathname || "/";
    } catch {
      return null;
    }
  })();

  let browser = null;
  let context = null;
  let page = null;
  let recordedVideo = null;
  let finalUrlLeakedToPreviewRoute = false;

  async function captureScreenshot(fileName, label) {
    if (!page) {
      return;
    }

    const filePath = path.join(outputDir, fileName);
    const captured = await page.screenshot({ path: filePath, fullPage: true }).then(() => true).catch(() => false);
    if (!captured) {
      return;
    }

    screenshotArtifacts.push({
      kind: "screenshot",
      label,
      filePath,
      contentType: "image/png"
    });
  }

  try {
    const launchPhase = phaseTracker.start("launch_browser", "Launch browser");
    browser = await chromium.launch({ headless: mode === "headless" });
    phaseTracker.finish(launchPhase, "completed", mode === "headful" ? "Headed browser launched." : "Headless browser launched.");

    const contextPhase = phaseTracker.start("create_context", "Create context");
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: {
        dir: outputDir,
        size: { width: 1440, height: 900 }
      }
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
    await context.tracing.start({ screenshots: true, snapshots: true });
    phaseTracker.finish(
      contextPhase,
      "completed",
      `Headers=${Object.keys(headers).length}. Cookies=${cookies.length}.`
    );

    page = await context.newPage();
    recordedVideo = page.video();

    page.on("console", (message) => {
      consoleMessageCount += 1;
      if (consoleMessages.length >= MAX_CAPTURED_CONSOLE_MESSAGES) {
        return;
      }

      consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: buildLocation(message.location())
      });
    });

    page.on("pageerror", (pageError) => {
      pageErrorCount += 1;
      if (pageErrors.length >= MAX_CAPTURED_PAGE_ERRORS) {
        return;
      }

      pageErrors.push(toErrorMessage(pageError));
    });

    page.on("requestfailed", (request) => {
      const failure = request.failure();
      const resourceType = request.resourceType();
      const requestUrl = request.url();
      const errorText = failure?.errorText ?? null;
      if (isIgnorableRequestFailure(resourceType, requestUrl, errorText)) {
        return;
      }

      failedRequestCount += 1;
      if (requestUrl.startsWith("ws:") || requestUrl.startsWith("wss:") || resourceType === "websocket") {
        websocketFailureCount += 1;
      }
      if (safeOrigin(requestUrl) === targetOrigin && looksLikeStaticResource(resourceType, requestUrl)) {
        sameOriginAssetFailureCount += 1;
      }
      if (failedRequests.length >= MAX_CAPTURED_FAILED_REQUESTS) {
        return;
      }

      failedRequests.push({
        url: requestUrl,
        method: request.method(),
        errorText
      });
    });

    page.on("response", (response) => {
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

      responseErrorCount += 1;
      if ((requestUrl.startsWith("ws:") || requestUrl.startsWith("wss:") || resourceType === "websocket") && responseStatus >= 400) {
        websocketFailureCount += 1;
      }
      if (safeOrigin(requestUrl) === targetOrigin && looksLikeStaticResource(resourceType, requestUrl)) {
        sameOriginAssetFailureCount += 1;
      }
    });

    const openPhase = phaseTracker.start("open_page", "Open page");
    const response = await page.goto(targetUrl, { waitUntil: "load", timeout: 45000 });
    status = response?.status() ?? null;
    phaseTracker.finish(openPhase, "completed", status === null ? "No response status was reported." : `HTTP ${status}.`);

    const readyPhase = phaseTracker.start("await_ready", "Wait for ready");
    await page.locator("body").first().waitFor({ state: "visible", timeout: 45000 });
    if (waitForSelector) {
      await page.locator(waitForSelector).first().waitFor({ state: "visible", timeout: 45000 });
      selectorSatisfied = true;
    }
    if (postLoadWaitMs > 0) {
      await page.waitForTimeout(postLoadWaitMs);
    }
    phaseTracker.finish(
      readyPhase,
      "completed",
      waitForSelector ? `Locator ready: ${waitForSelector}` : "Page loaded and body became visible."
    );
    await captureScreenshot("ready.png", "Ready screenshot");

    if (script) {
      const scriptPhase = phaseTracker.start("run_script", "Run interaction script");
      try {
        const runner = new AsyncFunction("page", "context", "browser", "chromium", "manor", script);
        await runner(page, context, browser, chromium, Object.freeze({ targetUrl, outputDir, runId }));
        if (page.isClosed()) {
          throw new Error("Browser script closed the page before proof capture completed.");
        }
        if (typeof browser?.isConnected === "function" && browser.isConnected() === false) {
          throw new Error("Browser script disconnected the browser before proof capture completed.");
        }
        phaseTracker.finish(scriptPhase, "completed", "Browser interaction script finished.");
        await captureScreenshot("after-script.png", "After script screenshot");
      } catch (scriptError) {
        failedPhase = "run_script";
        phaseTracker.finish(scriptPhase, "failed", toErrorMessage(scriptError));
        throw scriptError;
      }
    } else {
      const scriptPhase = phaseTracker.start("run_script", "Run interaction script");
      phaseTracker.finish(scriptPhase, "skipped", "No browser script supplied.");
    }

    title = await page.title().catch(() => "");
    finalUrl = page.url() || targetUrl;
    const htmlSignals = await page
      .evaluate(() => {
        const titleText = document.title || "";
        const bodyText = document.body?.innerText?.slice(0, 4000) || "";
        return { titleText, bodyText };
      })
      .catch(() => ({ titleText: title, bodyText: "" }));
    htmlErrorSignals = detectHtmlErrorSignals(htmlSignals.titleText || title, htmlSignals.bodyText);
    try {
      const targetPathname = new URL(targetUrl).pathname;
      const finalPathname = new URL(finalUrl).pathname;
      finalUrlLeakedToPreviewRoute = !targetPathname.startsWith("/preview/") && finalPathname.startsWith("/preview/");
    } catch {
      finalUrlLeakedToPreviewRoute = false;
    }
    if (finalUrlLeakedToPreviewRoute) {
      htmlErrorSignals = [...new Set([...htmlErrorSignals, "Preview route content"])];
    }
    const loginRedirectDetected =
      !/\/(?:login|sign-?in|auth)\b/i.test(expectedPath || "") && /\/(?:login|sign-?in|auth)\b/i.test(finalUrl);
    ok = status !== null ? status < 400 && !loginRedirectDetected : finalUrl !== "about:blank";
    if (finalUrlLeakedToPreviewRoute) {
      ok = false;
      if (!error) {
        error = "Verification ended on a preview route instead of the requested page.";
      }
    }
    if (!ok && !error && status !== null) {
      error = loginRedirectDetected ? "Redirected to login instead of the target page." : `Received HTTP ${status}`;
    }
  } catch (runError) {
    error = toErrorMessage(runError);
    liveCheckResult = parseLiveCheckResultError(error);
    if (page) {
      title = await page.title().catch(() => title);
      finalUrl = page.url() || finalUrl;
    }
    failedPhase = failedPhase || phaseTracker.phases.at(-1)?.name || "open_page";
    const lastPhase = phaseTracker.phases.at(-1);
    if (lastPhase && lastPhase.status === "completed") {
      phaseTracker.finish(lastPhase, "failed", error);
    }
  } finally {
    const capturePhase = phaseTracker.start("capture_artifacts", "Capture artifacts");

    if (page) {
      await captureScreenshot("final.png", "Final screenshot");
      await page
        .content()
        .then((html) => fs.writeFile(htmlPath, html, "utf8"))
        .catch(() => undefined);
    }

    if (context) {
      await context.tracing.stop({ path: tracePath }).catch(() => undefined);
    }

    if (page) {
      await page.close().catch(() => undefined);
    }

    phaseTracker.finish(capturePhase, "completed", "Screenshots, HTML, trace, and video capture attempted.");

    if (context) {
      await context.close().catch(() => undefined);
    }

    if (recordedVideo) {
      const recordedPath = await Promise.race([
        recordedVideo.path().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 15000))
      ]);
      if (recordedPath) {
        const targetPath = path.join(outputDir, "video.webm");
        if (recordedPath !== targetPath) {
          await fs.rename(recordedPath, targetPath).catch(async () => {
            await fs.copyFile(recordedPath, targetPath).catch(() => undefined);
          });
        }
        videoPath = targetPath;
      }
    }

    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  const checkedAt = Date.now();
  const orderedScreenshotArtifacts = [...screenshotArtifacts].sort((left, right) => {
    const delta = rankScreenshotArtifact(left) - rankScreenshotArtifact(right);
    if (delta !== 0) {
      return delta;
    }
    return left.label.localeCompare(right.label);
  });

  const artifacts = await collectArtifacts([
    {
      kind: "manifest",
      label: "Manifest",
      filePath: manifestPath,
      contentType: "application/json"
    },
    ...orderedScreenshotArtifacts,
    {
      kind: "html",
      label: "Rendered HTML",
      filePath: htmlPath,
      contentType: "text/html; charset=utf-8"
    },
    {
      kind: "trace",
      label: "Playwright trace",
      filePath: tracePath,
      contentType: "application/zip"
    },
    {
      kind: "video",
      label: "Video",
      filePath: videoPath,
      contentType: "video/webm"
    }
  ]);

  const captureMissing = !artifacts.some((artifact) => artifact.kind === "screenshot") || !artifacts.some((artifact) => artifact.kind === "trace");
  if (!error && captureMissing) {
    error = "Required proof artifacts were not captured.";
  }

  if (error && liveCheckResult && isBenignLiveCheckResult(liveCheckResult)) {
    ok = true;
    error = null;
    failedPhase = null;
    title = typeof liveCheckResult.title === "string" && liveCheckResult.title.trim() ? liveCheckResult.title.trim() : title;
    finalUrl =
      typeof liveCheckResult.finalUrl === "string" && liveCheckResult.finalUrl.trim() ? liveCheckResult.finalUrl.trim() : finalUrl;
    const runScriptPhase = phaseTracker.phases.find((phase) => phase.name === "run_script");
    if (runScriptPhase) {
      phaseTracker.finish(runScriptPhase, "completed", "Ignored benign aborted prefetch requests from the custom page check.");
    }
  }

  const loginRedirectDetected =
    !/\/(?:login|sign-?in|auth)\b/i.test(expectedPath || "") && /\/(?:login|sign-?in|auth)\b/i.test(finalUrl);
  const verifierScriptFailure = failedPhase === "run_script" && isVerifierScriptFailure(error);
  const failureKind = classifyFailure({
    ok,
    error,
    status,
    failedPhase,
    selectorExpected: Boolean(waitForSelector),
    selectorSatisfied,
    sameOriginAssetFailureCount,
    htmlErrorSignals,
    loginRedirectDetected,
    captureMissing,
    verifierScriptFailure
  });

  const result = {
    runId,
    mode,
    checkedAt,
    durationMs: checkedAt - startedAt,
    ok,
    status,
    title,
    url: finalUrl,
    error,
    failureKind,
    summary: {
      consoleMessageCount,
      pageErrorCount,
      failedRequestCount,
      responseErrorCount,
      assetFailureCount: sameOriginAssetFailureCount,
      phaseCount: phaseTracker.phases.length
    },
    phases: phaseTracker.phases,
    readiness: {
      initialUrl: targetUrl,
      finalUrl,
      expectedPath,
      selector: waitForSelector || null,
      selectorSatisfied,
      routeStatus: status,
      routeOk: status !== null ? status < 400 : ok,
      loginRedirectDetected,
      htmlErrorSignals,
      sameOriginAssetFailureCount,
      websocketFailureCount,
      notes: [
        Object.keys(headers).length > 0 ? `${Object.keys(headers).length} request headers injected.` : "",
        cookies.length > 0 ? `${cookies.length} cookies injected.` : "",
        postLoadWaitMs > 0 ? `Post-load wait ${postLoadWaitMs}ms.` : "",
        failedPhase ? `Failed phase: ${failedPhase}.` : ""
      ].filter(Boolean)
    },
    auth: {
      headerCount: Object.keys(headers).length,
      cookieCount: cookies.length,
      cookieNames: cookies.map((entry) => entry.name),
      usedSessionCookie: cookies.some((entry) => entry.name === "better-auth.session_token")
    },
    artifacts,
    consoleMessages,
    pageErrors,
    failedRequests
  };

  await fs.writeFile(manifestPath, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

run().catch(async (error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exit(1);
});
