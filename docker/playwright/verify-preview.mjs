#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const MAX_CAPTURED_CONSOLE_MESSAGES = 12;
const MAX_CAPTURED_PAGE_ERRORS = 8;
const MAX_CAPTURED_FAILED_REQUESTS = 12;

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

async function run() {
  const rawOptions = process.argv[2];
  if (!rawOptions) {
    throw new Error("Missing verification options");
  }

  const options = JSON.parse(rawOptions);
  const targetUrl = typeof options.targetUrl === "string" ? options.targetUrl : "";
  const outputDir = typeof options.outputDir === "string" ? options.outputDir : "";
  const mode = options.mode === "headful" ? "headful" : "headless";
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

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  let consoleMessageCount = 0;
  let pageErrorCount = 0;
  let failedRequestCount = 0;
  let status = null;
  let title = "";
  let finalUrl = targetUrl;
  let error = null;
  let ok = false;

  let browser = null;
  let context = null;
  let page = null;

  try {
    browser = await chromium.launch({ headless: mode === "headless" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();

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
      if (failedRequests.length >= MAX_CAPTURED_FAILED_REQUESTS) {
        return;
      }

      const failure = request.failure();
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        errorText: failure?.errorText ?? null
      });
    });

    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = response?.status() ?? null;
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // Some previews intentionally keep long-lived connections open.
    }
    title = await page.title().catch(() => "");
    finalUrl = page.url() || targetUrl;
    ok = status !== null ? status < 400 : finalUrl !== "about:blank";
    if (!ok && !error && status !== null) {
      error = `Received HTTP ${status}`;
    }
  } catch (runError) {
    error = toErrorMessage(runError);
    if (page) {
      title = await page.title().catch(() => title);
      finalUrl = page.url() || finalUrl;
    }
  } finally {
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await page
        .content()
        .then((html) => fs.writeFile(htmlPath, html, "utf8"))
        .catch(() => undefined);
    }

    if (context) {
      await context.tracing.stop({ path: tracePath }).catch(() => undefined);
      await context.close().catch(() => undefined);
    }

    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  const checkedAt = Date.now();
  const baseResult = {
    runId,
    mode,
    checkedAt,
    durationMs: checkedAt - startedAt,
    ok,
    status,
    title,
    url: finalUrl,
    error,
    summary: {
      consoleMessageCount,
      pageErrorCount,
      failedRequestCount
    },
    artifacts: [],
    consoleMessages,
    pageErrors,
    failedRequests
  };

  await fs.writeFile(manifestPath, JSON.stringify(baseResult, null, 2));

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
    }
  ]);

  const result = {
    ...baseResult,
    artifacts
  };

  await fs.writeFile(manifestPath, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

run().catch(async (error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exit(1);
});
