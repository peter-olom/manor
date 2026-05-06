#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

const port = Number(process.env.MANOR_DESKTOP_PROOF_PORT ?? "3888");
const display = process.env.DISPLAY || ":99";
const sessionTtlMs = Number(process.env.MANOR_DESKTOP_PROOF_SESSION_TTL_MS ?? `${60 * 60 * 1000}`);
const desktopHome = process.env.HOME || "/state/home";
const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(desktopHome, ".config");
const xdgCacheHome = process.env.XDG_CACHE_HOME || path.join(desktopHome, ".cache");
const xdgDataHome = process.env.XDG_DATA_HOME || path.join(desktopHome, ".local/share");

const sessions = new Map();

function now() {
  return Date.now();
}

function toErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEnv(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, envValue]) => typeof key === "string" && typeof envValue === "string")
      .map(([key, envValue]) => [key.trim(), envValue.trim()])
      .filter(([key, envValue]) => key.length > 0 && envValue.length > 0)
  );
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [typeof options.stdin === "string" ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DISPLAY: display,
        HOME: desktopHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_DATA_HOME: xdgDataHome,
        ...(options.env ?? {})
      },
      cwd: options.cwd || process.cwd()
    });
    let stdout = "";
    let stderr = "";
    if (typeof options.stdin === "string" && child.stdin) {
      child.stdin.end(options.stdin);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: null, stdout, stderr: stderr || toErrorMessage(error) });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function optionalInteger(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function requiredCoordinate(input, key) {
  const value = optionalInteger(input[key]);
  if (value === null) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parseWindowList(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        return { raw: line };
      }
      return {
        id: match[1],
        desktop: match[2],
        pid: match[3],
        host: match[4],
        title: match[5] || ""
      };
    });
}

function setClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("xclip", ["-selection", "clipboard"], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
      env: {
        ...process.env,
        DISPLAY: display,
        HOME: desktopHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_DATA_HOME: xdgDataHome
      }
    });
    let stderr = "";
    let settled = false;
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      child.unref();
      resolve();
    };
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settle(error);
    });
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        settle(new Error(stderr || `xclip exited ${exitCode}`));
      } else {
        settle();
      }
    });
    child.stdin.end(text, () => {
      setTimeout(() => settle(), 150).unref();
    });
  });
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

async function captureScreenshot(session, fileName, label) {
  const filePath = path.join(session.outputDir, fileName);
  const result = await runCommand("scrot", ["-z", filePath]);
  if (result.exitCode !== 0) {
    session.captureErrors.push(result.stderr || `scrot exited ${result.exitCode}`);
    return false;
  }
  session.screenshotArtifacts.push({
    kind: "screenshot",
    label,
    filePath,
    contentType: "image/png"
  });
  return true;
}

function sessionSummary(session) {
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    mode: "headful",
    title: session.title,
    command: session.command,
    cwd: session.cwd,
    outputDir: session.outputDir,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    pid: session.child?.pid ?? null,
    running: Boolean(session.child && session.exitCode === null),
    exitCode: session.exitCode,
    actionCount: session.actions.length,
    vncUrl: `http://127.0.0.1:${process.env.MANOR_DESKTOP_PROOF_VNC_PORT ?? "6080"}/vnc.html`
  };
}

async function startSession(input) {
  const command = normalizeString(input.command);
  const cwd = normalizeString(input.cwd) || "/repos";
  const outputDir = normalizeString(input.outputDir);
  if (!command || !outputDir) {
    throw new Error("command and outputDir are required");
  }

  const runId = normalizeString(input.runId) || `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionId = normalizeString(input.sessionId) || randomUUID();
  const title = normalizeString(input.title) || command;
  const env = normalizeEnv(input.env);
  const waitMs =
    typeof input.waitMs === "number" && Number.isFinite(input.waitMs) ? Math.max(0, Math.trunc(input.waitMs)) : 3000;

  await fs.mkdir(outputDir, { recursive: true });
  const stdoutPath = path.join(outputDir, "stdout.log");
  const stderrPath = path.join(outputDir, "stderr.log");
  const manifestPath = path.join(outputDir, "manifest.json");

  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env: {
      ...process.env,
      ...env,
      DISPLAY: display,
      HOME: desktopHome,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      ELECTRON_ENABLE_LOGGING: env.ELECTRON_ENABLE_LOGGING || "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const startedAt = now();
  const session = {
    sessionId,
    runId,
    title,
    command,
    cwd,
    outputDir,
    stdoutPath,
    stderrPath,
    manifestPath,
    child,
    startedAt,
    lastActivityAt: startedAt,
    exitCode: null,
    exitSignal: null,
    error: null,
    actions: [],
    screenshotArtifacts: [],
    captureErrors: []
  };

  child.stdout.pipe(await fs.open(stdoutPath, "a").then((handle) => handle.createWriteStream()));
  child.stderr.pipe(await fs.open(stderrPath, "a").then((handle) => handle.createWriteStream()));
  child.on("error", (error) => {
    session.error = toErrorMessage(error);
  });
  child.on("exit", (exitCode, signal) => {
    session.exitCode = exitCode;
    session.exitSignal = signal;
    session.lastActivityAt = now();
  });

  sessions.set(sessionId, session);

  if (waitMs > 0) {
    await sleep(waitMs);
  }
  await captureScreenshot(session, "ready.png", "Ready desktop screenshot");
  session.lastActivityAt = now();

  return sessionSummary(session);
}

async function runAction(session, input) {
  const type = normalizeString(input.type).toLowerCase();
  if (!type) {
    throw new Error("Action type is required");
  }
  const startedAt = now();
  let output = null;
  if (type === "screenshot") {
    const fileName = normalizeString(input.fileName) || `${Date.now()}-desktop.png`;
    await captureScreenshot(session, fileName, normalizeString(input.label) || "Desktop screenshot");
  } else if (type === "wait") {
    const ms = typeof input.ms === "number" && Number.isFinite(input.ms) ? Math.max(0, Math.trunc(input.ms)) : 1000;
    await sleep(ms);
  } else if (type === "click") {
    const x = requiredCoordinate(input, "x");
    const y = requiredCoordinate(input, "y");
    const button = optionalInteger(input.button) ?? 1;
    const result = await runCommand("xdotool", ["mousemove", String(x), String(y), "click", String(button)]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool click failed");
    }
  } else if (type === "drag") {
    const x = requiredCoordinate(input, "x");
    const y = requiredCoordinate(input, "y");
    const toX = requiredCoordinate(input, "toX");
    const toY = requiredCoordinate(input, "toY");
    const button = optionalInteger(input.button) ?? 1;
    const result = await runCommand("xdotool", [
      "mousemove",
      String(x),
      String(y),
      "mousedown",
      String(button),
      "mousemove",
      "--sync",
      String(toX),
      String(toY),
      "mouseup",
      String(button)
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool drag failed");
    }
  } else if (type === "key") {
    const key = normalizeString(input.key);
    if (!key) {
      throw new Error("key requires key");
    }
    const result = await runCommand("xdotool", ["key", key]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool key failed");
    }
  } else if (type === "type") {
    const text = typeof input.text === "string" ? input.text : "";
    const result = await runCommand("xdotool", ["type", "--delay", String(input.delayMs ?? 10), text]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool type failed");
    }
  } else if (type === "window_list") {
    const result = await runCommand("wmctrl", ["-l", "-p"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "wmctrl window list failed");
    }
    output = { windows: parseWindowList(result.stdout) };
  } else if (type === "focus_window") {
    const windowId = normalizeString(input.windowId);
    if (!windowId) {
      throw new Error("focus_window requires windowId");
    }
    const result = await runCommand("xdotool", ["windowactivate", "--sync", windowId]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool windowactivate failed");
    }
  } else if (type === "close_window") {
    const windowId = normalizeString(input.windowId);
    if (!windowId) {
      throw new Error("close_window requires windowId");
    }
    const result = await runCommand("xdotool", ["windowclose", windowId]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xdotool windowclose failed");
    }
  } else if (type === "clipboard_set") {
    const text = typeof input.text === "string" ? input.text : "";
    await setClipboard(text);
  } else if (type === "clipboard_get") {
    const result = await runCommand("xclip", ["-selection", "clipboard", "-out"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "xclip clipboard_get failed");
    }
    output = { text: result.stdout };
  } else {
    throw new Error(`Unsupported desktop action: ${type}`);
  }

  session.actions.push({
    type,
    at: now(),
    durationMs: Math.max(0, now() - startedAt),
    status: "completed",
    output
  });
  session.lastActivityAt = now();
  return {
    ok: true,
    action: { type, durationMs: Math.max(0, now() - startedAt), output },
    state: sessionSummary(session)
  };
}

async function stopSession(session, reason = "desktop session stop") {
  await captureScreenshot(session, "final.png", "Final desktop screenshot");

  if (session.child && session.exitCode === null) {
    try {
      process.kill(-session.child.pid, "SIGTERM");
    } catch {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
    await sleep(1000);
    if (session.exitCode === null) {
      try {
        process.kill(-session.child.pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  }

  const checkedAt = now();
  const artifacts = await collectArtifacts([
    { kind: "manifest", label: "Manifest", filePath: session.manifestPath, contentType: "application/json" },
    ...session.screenshotArtifacts,
    { kind: "other", label: "Stdout log", filePath: session.stdoutPath, contentType: "text/plain; charset=utf-8" },
    { kind: "other", label: "Stderr log", filePath: session.stderrPath, contentType: "text/plain; charset=utf-8" }
  ]);

  const hasScreenshot = artifacts.some((artifact) => artifact.kind === "screenshot");
  const exitedWithFailure = session.exitCode !== null && session.exitCode !== 0;
  const ok = !session.error && !exitedWithFailure && hasScreenshot;
  const error =
    session.error ||
    (exitedWithFailure ? `Desktop command exited with ${session.exitCode}.` : null) ||
    (!hasScreenshot ? "Desktop screenshot was not captured." : null);

  const verification = {
    runId: session.runId,
    mode: "headful",
    checkedAt,
    durationMs: checkedAt - session.startedAt,
    ok,
    status: null,
    title: session.title,
    url: `desktop://${session.sessionId}`,
    error,
    failureKind: ok ? "none" : session.error || exitedWithFailure ? "script" : "artifact",
    summary: {
      consoleMessageCount: 0,
      pageErrorCount: 0,
      failedRequestCount: 0,
      responseErrorCount: 0,
      assetFailureCount: 0,
      phaseCount: 4,
      actionCount: session.actions.length
    },
    phases: [
      {
        name: "launch_desktop",
        label: "Launch desktop app",
        status: session.error ? "failed" : "completed",
        startedAt: session.startedAt,
        completedAt: session.startedAt,
        durationMs: 0,
        message: session.error
      },
      {
        name: "capture_ready",
        label: "Capture ready screenshot",
        status: hasScreenshot ? "completed" : "failed",
        startedAt: session.startedAt,
        completedAt: checkedAt,
        durationMs: Math.max(0, checkedAt - session.startedAt),
        message: hasScreenshot ? "Ready desktop screenshot captured." : "No desktop screenshot was captured."
      },
      {
        name: "close_desktop",
        label: "Close desktop app",
        status: "completed",
        startedAt: checkedAt,
        completedAt: checkedAt,
        durationMs: 0,
        message: reason
      },
      {
        name: "collect_logs",
        label: "Collect logs",
        status: "completed",
        startedAt: checkedAt,
        completedAt: checkedAt,
        durationMs: 0,
        message: "Captured stdout and stderr logs."
      }
    ],
    readiness: {
      initialUrl: `desktop://${session.sessionId}`,
      finalUrl: `desktop://${session.sessionId}`,
      expectedPath: null,
      selector: null,
      selectorSatisfied: null,
      routeStatus: null,
      routeOk: ok,
      loginRedirectDetected: false,
      visualContentDetected: hasScreenshot,
      visualSignals: null,
      htmlErrorSignals: [],
      sameOriginAssetFailureCount: 0,
      websocketFailureCount: 0,
      notes: [`Session closed: ${reason}.`]
    },
    auth: {
      headerCount: 0,
      cookieCount: 0,
      cookieNames: [],
      usedSessionCookie: false
    },
    diagnostics: {
      stages: {
        processUp: {
          name: "process_up",
          ok: !session.error,
          detail: session.error ? session.error : "Desktop command launched.",
          status: session.exitCode,
          hint: session.error ? "Check the desktop command and project dependencies." : null,
          failureKind: session.error ? "script" : null
        },
        networkReachable: null,
        routeAuth: null,
        uiSelectorVisible: {
          name: "ui_selector_visible",
          ok: hasScreenshot,
          detail: hasScreenshot ? "Desktop screen capture succeeded." : "Desktop screen capture failed.",
          status: null,
          hint: hasScreenshot ? null : "Confirm the virtual display is running.",
          failureKind: hasScreenshot ? null : "artifact"
        }
      },
      remediationHints: [
        ...(session.error ? ["Check the desktop command and project dependencies."] : []),
        ...(session.captureErrors.length > 0 ? ["Confirm the virtual display can capture screenshots."] : [])
      ]
    },
    artifacts,
    consoleMessages: [],
    pageErrors: [],
    failedRequests: []
  };

  await fs.writeFile(session.manifestPath, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  sessions.delete(session.sessionId);
  return verification;
}

setInterval(() => {
  const cutoff = now() - sessionTtlMs;
  for (const session of sessions.values()) {
    if (session.lastActivityAt < cutoff) {
      void stopSession(session, "desktop session ttl expired").catch(() => undefined);
    }
  }
}, 30_000).unref();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        display,
        desktopHome,
        xdgConfigHome,
        vncUrl: `http://127.0.0.1:${process.env.MANOR_DESKTOP_PROOF_VNC_PORT ?? "6080"}/vnc.html`,
        activeSessionCount: sessions.size
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/sessions") {
      const body = await parseJsonBody(request);
      const session = await startSession(body);
      writeJson(response, 200, { ok: true, session });
      return;
    }

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/actions)?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, { error: `Desktop session ${sessionId} was not found.` });
        return;
      }

      if (request.method === "GET" && !url.pathname.endsWith("/actions")) {
        writeJson(response, 200, { ok: true, session: sessionSummary(session) });
        return;
      }

      if (request.method === "POST" && url.pathname.endsWith("/actions")) {
        const body = await parseJsonBody(request);
        const result = await runAction(session, body);
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "DELETE" && !url.pathname.endsWith("/actions")) {
        const body = await parseJsonBody(request);
        const verification = await stopSession(session, normalizeString(body.reason) || "desktop session stop");
        writeJson(response, 200, { ok: true, verification });
        return;
      }
    }

    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Desktop proof control listening on ${port}`);
});
