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

function detectHtmlErrorSignals(title, bodyText) {
  const signals = [];
  const normalized = `${title}\n${bodyText}`.toLowerCase();
  const candidates = [
    { pattern: /502 bad gateway/, label: "502 Bad Gateway" },
    { pattern: /504 gateway timeout/, label: "504 Gateway Timeout" },
    { pattern: /500 internal server error/, label: "500 Internal Server Error" },
    { pattern: /application error/, label: "Application error" },
    { pattern: /something went wrong/, label: "Something went wrong" },
    { pattern: /not found/, label: "Not found" },
    { pattern: /sign in|login/, label: "Login screen" }
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

function classifyFailure(input) {
  if (input.ok) {
    return "none";
  }

  if (input.failedPhase === "run_script") {
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
  const screenshotPath = path.join(outputDir, "screenshot.png");
  const htmlPath = path.join(outputDir, "page.html");
  const tracePath = path.join(outputDir, "trace.zip");
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
      failedRequestCount += 1;
      const failure = request.failure();
      const resourceType = request.resourceType();
      const requestUrl = request.url();
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
        errorText: failure?.errorText ?? null
      });
    });

    page.on("response", (response) => {
      const responseStatus = response.status();
      if (responseStatus < 400) {
        return;
      }
      responseErrorCount += 1;
      const request = response.request();
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if ((requestUrl.startsWith("ws:") || requestUrl.startsWith("wss:") || resourceType === "websocket") && responseStatus >= 400) {
        websocketFailureCount += 1;
      }
      if (safeOrigin(requestUrl) === targetOrigin && looksLikeStaticResource(resourceType, requestUrl)) {
        sameOriginAssetFailureCount += 1;
      }
    });

    const openPhase = phaseTracker.start("open_page", "Open page");
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = response?.status() ?? null;
    phaseTracker.finish(openPhase, "completed", status === null ? "No response status was reported." : `HTTP ${status}.`);

    const readyPhase = phaseTracker.start("await_ready", "Wait for ready");
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 45000 });
      selectorSatisfied = true;
    }
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Long-lived connections are expected for some previews.
    }
    if (postLoadWaitMs > 0) {
      await page.waitForTimeout(postLoadWaitMs);
    }
    phaseTracker.finish(
      readyPhase,
      "completed",
      waitForSelector ? `Selector ready: ${waitForSelector}` : "DOM content loaded and network settled."
    );

    if (script) {
      const scriptPhase = phaseTracker.start("run_script", "Run interaction script");
      try {
        const runner = new AsyncFunction("page", "context", "browser", "chromium", "targetUrl", script);
        await runner(page, context, browser, chromium, targetUrl);
        phaseTracker.finish(scriptPhase, "completed", "Browser interaction script finished.");
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
    const loginRedirectDetected =
      !/\/(?:login|sign-?in|auth)\b/i.test(expectedPath || "") && /\/(?:login|sign-?in|auth)\b/i.test(finalUrl);
    ok = status !== null ? status < 400 && !loginRedirectDetected : finalUrl !== "about:blank";
    if (!ok && !error && status !== null) {
      error = loginRedirectDetected ? "Redirected to login instead of the target page." : `Received HTTP ${status}`;
    }
  } catch (runError) {
    error = toErrorMessage(runError);
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
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
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

    phaseTracker.finish(capturePhase, "completed", "Screenshot, HTML, trace, and video capture attempted.");

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
  const artifacts = await collectArtifacts([
    {
      kind: "manifest",
      label: "Manifest",
      filePath: manifestPath,
      contentType: "application/json"
    },
    {
      kind: "screenshot",
      label: "Screenshot",
      filePath: screenshotPath,
      contentType: "image/png"
    },
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

  const loginRedirectDetected =
    !/\/(?:login|sign-?in|auth)\b/i.test(expectedPath || "") && /\/(?:login|sign-?in|auth)\b/i.test(finalUrl);
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
    captureMissing
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
