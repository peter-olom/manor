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
const desktopProfilesDir = process.env.MANOR_DESKTOP_PROOF_PROFILES_DIR || "/state/profiles";

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

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const folded = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(folded)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(folded)) {
      return false;
    }
  }
  return fallback;
}

function safePathSegment(value, fallback) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
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

function normalizeStringArray(value) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(entries.map((entry) => normalizeString(entry)).filter(Boolean))];
}

function buildDesktopEnv(options = {}) {
  const home = normalizeString(options.home) || desktopHome;
  return {
    ...process.env,
    ...(options.extra ?? {}),
    DISPLAY: display,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share")
  };
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
      env: buildDesktopEnv({ home: options.home, extra: options.env }),
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

function parseWorkspaceList(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([*-])\s+DG:\s+\S+\s+VP:\s+\S+\s+WA:\s+\S+\s+\S+\s*(.*)$/);
      if (!match) {
        return null;
      }
      return {
        index: Number(match[1]),
        active: match[2] === "*",
        name: normalizeString(match[3]) || null
      };
    })
    .filter(Boolean);
}

async function getWorkspaceList(home = desktopHome) {
  const result = await runCommand("wmctrl", ["-d"], { home });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "wmctrl workspace list failed");
  }
  return parseWorkspaceList(result.stdout);
}

async function setWorkspaceCount(count, home = desktopHome) {
  const result = await runCommand("wmctrl", ["-n", String(count)], { home });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "wmctrl workspace count failed");
  }
}

async function switchWorkspace(index, home = desktopHome) {
  const result = await runCommand("wmctrl", ["-s", String(index)], { home });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "wmctrl workspace switch failed");
  }
}

async function setCurrentWorkspaceName(name, home = desktopHome) {
  const normalized = normalizeString(name);
  if (!normalized) {
    return;
  }
  const result = await runCommand("fluxbox-remote", [`SetWorkspaceName ${normalized}`], { home });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "fluxbox workspace rename failed");
  }
}

function usedWorkspaceIndexes(excludeSessionId = null) {
  const used = new Set();
  for (const session of sessions.values()) {
    if (excludeSessionId && session.sessionId === excludeSessionId) {
      continue;
    }
    if (session.child && session.exitCode === null && typeof session.workspaceIndex === "number") {
      used.add(session.workspaceIndex);
    }
  }
  return used;
}

function buildWorkspaceTarget(input) {
  const fallbackKey =
    normalizeString(input.workspaceKey) ||
    normalizeString(input.threadId) ||
    normalizeString(input.owner) ||
    normalizeString(input.sessionId) ||
    "desktop";
  return {
    workspaceKey: fallbackKey,
    workspaceName: normalizeString(input.workspaceName) || fallbackKey
  };
}

async function ensureWorkspaceForSession(input) {
  const target = buildWorkspaceTarget(input);
  const existingSession = [...sessions.values()].find(
    (session) =>
      session.child &&
      session.exitCode === null &&
      session.workspaceKey === target.workspaceKey &&
      typeof session.workspaceIndex === "number"
  );
  if (existingSession) {
    await switchWorkspace(existingSession.workspaceIndex, existingSession.profileHome);
    await setCurrentWorkspaceName(target.workspaceName, existingSession.profileHome);
    return {
      ...target,
      workspaceIndex: existingSession.workspaceIndex
    };
  }

  let workspaces = await getWorkspaceList();
  if (workspaces.length === 0) {
    await setWorkspaceCount(1);
    await sleep(250);
    workspaces = await getWorkspaceList();
  }

  const used = usedWorkspaceIndexes(normalizeString(input.sessionId) || null);
  let workspace = workspaces.find((entry) => entry.name === target.workspaceName) ?? workspaces.find((entry) => !used.has(entry.index));
  if (!workspace) {
    await setWorkspaceCount(workspaces.length + 1);
    await sleep(250);
    workspaces = await getWorkspaceList();
    workspace = workspaces[workspaces.length - 1] ?? { index: workspaces.length, active: false, name: null };
  }

  await switchWorkspace(workspace.index);
  await setCurrentWorkspaceName(target.workspaceName);
  return {
    ...target,
    workspaceIndex: workspace.index
  };
}

async function activateSessionWorkspace(session) {
  if (typeof session.workspaceIndex !== "number") {
    return null;
  }
  await switchWorkspace(session.workspaceIndex, session.profileHome);
  await setCurrentWorkspaceName(session.workspaceName, session.profileHome);
  const workspaces = await getWorkspaceList(session.profileHome).catch(() => []);
  return {
    key: session.workspaceKey,
    name: session.workspaceName,
    index: session.workspaceIndex,
    active: workspaces.find((entry) => entry.index === session.workspaceIndex)?.active ?? null
  };
}

function setClipboard(text, home = desktopHome) {
  return new Promise((resolve, reject) => {
    const child = spawn("xclip", ["-selection", "clipboard"], {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
      env: buildDesktopEnv({ home })
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
  const result = await runCommand("scrot", ["-z", filePath], { home: session.profileHome });
  if (result.exitCode !== 0) {
    session.captureErrors.push(result.stderr || `scrot exited ${result.exitCode}`);
    return null;
  }
  const descriptor = {
    kind: "screenshot",
    label,
    filePath,
    contentType: "image/png"
  };
  session.screenshotArtifacts.push(descriptor);
  return buildArtifact(descriptor.kind, descriptor.label, descriptor.filePath, descriptor.contentType);
}

async function getWindowList(session) {
  const result = await runCommand("wmctrl", ["-l", "-p"], { home: session.profileHome });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "wmctrl window list failed");
  }
  return parseWindowList(result.stdout);
}

async function getPointerLocation(session) {
  const result = await runCommand("xdotool", ["getmouselocation", "--shell"], { home: session.profileHome });
  if (result.exitCode !== 0) {
    return null;
  }
  const values = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.split("=");
        return [key?.toLowerCase(), value];
      })
      .filter(([key, value]) => key && value)
  );
  return {
    x: Number(values.x ?? 0),
    y: Number(values.y ?? 0),
    screen: Number(values.screen ?? 0),
    window: values.window ?? null
  };
}

async function getDisplayGeometry(session) {
  const result = await runCommand("xdpyinfo", [], { home: session.profileHome });
  if (result.exitCode !== 0) {
    return null;
  }
  const match = result.stdout.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/i);
  return match
    ? {
        width: Number(match[1]),
        height: Number(match[2])
      }
    : null;
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
    interactive: session.interactive,
    owner: session.owner,
    lockOwner: session.lockOwner,
    lockExpiresAt: session.lockExpiresAt,
    profileKey: session.profileKey,
    profileHome: session.profileHome,
    attachedThreadIds: session.attachedThreadIds,
    workspaceKey: session.workspaceKey,
    workspaceName: session.workspaceName,
    workspaceIndex: session.workspaceIndex,
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
  const profileKey = normalizeString(input.profileKey);
  const profileHome = profileKey ? path.join(desktopProfilesDir, safePathSegment(profileKey, "default")) : desktopHome;
  const owner = normalizeString(input.owner) || "agent";
  const interactive = normalizeBoolean(input.interactive, false);
  const attachedThreadIds = normalizeStringArray(input.attachedThreadIds);
  const workspace = await ensureWorkspaceForSession({
    ...input,
    sessionId,
    owner
  });
  const waitMs =
    typeof input.waitMs === "number" && Number.isFinite(input.waitMs) ? Math.max(0, Math.trunc(input.waitMs)) : 3000;

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(profileHome, ".config"), { recursive: true });
  await fs.mkdir(path.join(profileHome, ".cache"), { recursive: true });
  await fs.mkdir(path.join(profileHome, ".local/share"), { recursive: true });
  const stdoutPath = path.join(outputDir, "stdout.log");
  const stderrPath = path.join(outputDir, "stderr.log");
  const manifestPath = path.join(outputDir, "manifest.json");
  const actionLogPath = path.join(outputDir, "actions.json");

  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    env: buildDesktopEnv({
      home: profileHome,
      extra: {
        ...env,
        ELECTRON_ENABLE_LOGGING: env.ELECTRON_ENABLE_LOGGING || "1"
      }
    }),
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
    actionLogPath,
    profileKey: profileKey || null,
    profileHome,
    owner,
    interactive,
    attachedThreadIds,
    workspaceKey: workspace.workspaceKey,
    workspaceName: workspace.workspaceName,
    workspaceIndex: workspace.workspaceIndex,
    lockOwner: null,
    lockExpiresAt: null,
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

function isMutatingAction(type) {
  return [
    "click",
    "click_text",
    "drag",
    "key",
    "type",
    "focus_window",
    "close_window",
    "clipboard_set"
  ].includes(type);
}

function requireSessionLock(session, type, input) {
  if (session.lockExpiresAt && session.lockExpiresAt <= now()) {
    session.lockOwner = null;
    session.lockExpiresAt = null;
  }
  if (!isMutatingAction(type) || normalizeBoolean(input.force, false)) {
    return;
  }
  const actor = normalizeString(input.actor) || session.owner || "agent";
  if (session.lockOwner && session.lockOwner !== actor) {
    throw new Error(`Desktop session is locked by ${session.lockOwner}. Retry as that actor or pass force.`);
  }
}

function summarizeActionInput(input) {
  const safe = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (["text", "value"].includes(key) && typeof value === "string") {
      safe[key] = value.length > 160 ? `${value.slice(0, 157)}...` : value;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}

function parseTesseractTsv(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }
  const headers = lines[0].split("\t");
  return lines
    .slice(1)
    .map((line) => {
      const columns = line.split("\t");
      const row = Object.fromEntries(headers.map((header, index) => [header, columns[index] ?? ""]));
      const text = normalizeString(row.text);
      const confidence = Number(row.conf ?? "-1");
      const left = Number(row.left ?? 0);
      const top = Number(row.top ?? 0);
      const width = Number(row.width ?? 0);
      const height = Number(row.height ?? 0);
      if (!text || !Number.isFinite(confidence) || confidence < 0 || width <= 0 || height <= 0) {
        return null;
      }
      return {
        text,
        confidence,
        left,
        top,
        width,
        height,
        centerX: left + width / 2,
        centerY: top + height / 2,
        block: row.block_num,
        paragraph: row.par_num,
        line: row.line_num
      };
    })
    .filter(Boolean);
}

function findOcrMatch(words, targetText, matchMode) {
  const target = normalizeString(targetText).toLowerCase();
  if (!target) {
    throw new Error("click_text requires text");
  }
  const mode = normalizeString(matchMode).toLowerCase() || "contains";
  const matchesText = (text) => {
    const folded = text.toLowerCase();
    return mode === "exact" ? folded === target : folded.includes(target);
  };

  const direct = words.find((word) => matchesText(word.text));
  if (direct) {
    return direct;
  }

  const lines = new Map();
  for (const word of words) {
    const key = [word.block, word.paragraph, word.line].join(":");
    const line = lines.get(key) ?? [];
    line.push(word);
    lines.set(key, line);
  }

  for (const lineWords of lines.values()) {
    const sorted = lineWords.sort((left, right) => left.left - right.left);
    const text = sorted.map((word) => word.text).join(" ");
    if (!matchesText(text)) {
      continue;
    }
    const left = Math.min(...sorted.map((word) => word.left));
    const top = Math.min(...sorted.map((word) => word.top));
    const right = Math.max(...sorted.map((word) => word.left + word.width));
    const bottom = Math.max(...sorted.map((word) => word.top + word.height));
    return {
      text,
      confidence: Math.min(...sorted.map((word) => word.confidence)),
      left,
      top,
      width: right - left,
      height: bottom - top,
      centerX: left + (right - left) / 2,
      centerY: top + (bottom - top) / 2
    };
  }
  return null;
}

async function getCdpTargets(input) {
  const explicitUrl = normalizeString(input.cdpUrl);
  const port = optionalInteger(input.cdpPort);
  const baseUrl = explicitUrl || (port ? `http://127.0.0.1:${port}` : "");
  if (!baseUrl) {
    throw new Error("cdp_targets requires cdpUrl or cdpPort");
  }
  const endpoint = new URL("/json/list", baseUrl).toString();
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`CDP target list failed with ${response.status}`);
  }
  const targets = await response.json();
  return {
    endpoint,
    targets: Array.isArray(targets) ? targets : []
  };
}

async function callCdpWebSocket(webSocketDebuggerUrl, method, params = {}) {
  if (typeof WebSocket !== "function") {
    throw new Error("This Node runtime does not expose WebSocket for CDP calls.");
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      reject(new Error("CDP call timed out"));
    }, 10_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (payload.error) {
        reject(new Error(payload.error.message || "CDP call failed"));
      } else {
        resolve(payload.result ?? null);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket connection failed"));
    });
  });
}

async function runCdpAccessibility(input) {
  const { targets } = await getCdpTargets(input);
  const target = targets.find((entry) => entry?.webSocketDebuggerUrl && entry.type === "page") ?? targets.find((entry) => entry?.webSocketDebuggerUrl);
  if (!target) {
    throw new Error("No CDP target with a websocket debugger URL was found.");
  }
  const tree = await callCdpWebSocket(target.webSocketDebuggerUrl, "Accessibility.getFullAXTree");
  return {
    target: {
      id: target.id,
      title: target.title,
      url: target.url,
      type: target.type
    },
    tree
  };
}

async function runAction(session, input) {
  const type = normalizeString(input.type).toLowerCase();
  if (!type) {
    throw new Error("Action type is required");
  }
  const startedAt = now();
  const actor = normalizeString(input.actor) || session.owner || "agent";
  let output = null;
  try {
    requireSessionLock(session, type, input);
    const workspaceState = await activateSessionWorkspace(session);
    if (type === "lock") {
      if (session.lockOwner && session.lockOwner !== actor && !normalizeBoolean(input.force, false)) {
        throw new Error(`Desktop session is already locked by ${session.lockOwner}.`);
      }
      const ttlMs = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) ? Math.max(0, Math.trunc(input.ttlMs)) : 0;
      session.lockOwner = actor;
      session.lockExpiresAt = ttlMs > 0 ? now() + ttlMs : null;
      output = { lockOwner: session.lockOwner, lockExpiresAt: session.lockExpiresAt };
    } else if (type === "unlock") {
      if (session.lockOwner && session.lockOwner !== actor && !normalizeBoolean(input.force, false)) {
        throw new Error(`Desktop session is locked by ${session.lockOwner}.`);
      }
      session.lockOwner = null;
      session.lockExpiresAt = null;
      output = { lockOwner: null };
    } else if (type === "screenshot") {
      const fileName = normalizeString(input.fileName) || `${Date.now()}-desktop.png`;
      const artifact = await captureScreenshot(session, fileName, normalizeString(input.label) || "Desktop screenshot");
      output = { artifact };
    } else if (type === "current_screen") {
      const fileName = normalizeString(input.fileName) || `${Date.now()}-current-screen.png`;
      const [artifact, windows, pointer, geometry] = await Promise.all([
        captureScreenshot(session, fileName, normalizeString(input.label) || "Current desktop screen"),
        getWindowList(session).catch((error) => ({ error: error instanceof Error ? error.message : String(error), windows: [] })),
        getPointerLocation(session),
        getDisplayGeometry(session)
      ]);
      output = {
        screenshot: artifact,
        windows: Array.isArray(windows) ? windows : windows.windows,
        windowError: Array.isArray(windows) ? null : windows.error,
        pointer,
        geometry,
        workspace: workspaceState,
        workspaces: await getWorkspaceList(session.profileHome).catch(() => []),
        vncUrl: sessionSummary(session).vncUrl
      };
    } else if (type === "calibrate") {
      const [pointer, geometry] = await Promise.all([getPointerLocation(session), getDisplayGeometry(session)]);
      output = { pointer, geometry, display, workspace: workspaceState };
    } else if (type === "wait") {
      const ms = typeof input.ms === "number" && Number.isFinite(input.ms) ? Math.max(0, Math.trunc(input.ms)) : 1000;
      await sleep(ms);
    } else if (type === "click") {
      const x = requiredCoordinate(input, "x");
      const y = requiredCoordinate(input, "y");
      const button = optionalInteger(input.button) ?? 1;
      const result = await runCommand("xdotool", ["mousemove", String(x), String(y), "click", String(button)], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool click failed");
      }
    } else if (type === "click_text") {
      const targetText = normalizeString(input.text || input.targetText);
      const fileName = `${Date.now()}-ocr-click.png`;
      const artifact = await captureScreenshot(session, fileName, "OCR click target screenshot");
      if (!artifact) {
        throw new Error("Could not capture screenshot for OCR click.");
      }
      const ocr = await runCommand("tesseract", [artifact.filePath, "stdout", "--psm", "11", "tsv"], { home: session.profileHome });
      if (ocr.exitCode !== 0) {
        throw new Error(ocr.stderr || "tesseract OCR failed");
      }
      const words = parseTesseractTsv(ocr.stdout);
      const match = findOcrMatch(words, targetText, input.matchMode);
      if (!match) {
        throw new Error(`Could not find visible text "${targetText}".`);
      }
      const button = optionalInteger(input.button) ?? 1;
      const click = await runCommand(
        "xdotool",
        ["mousemove", String(Math.round(match.centerX)), String(Math.round(match.centerY)), "click", String(button)],
        { home: session.profileHome }
      );
      if (click.exitCode !== 0) {
        throw new Error(click.stderr || "xdotool click_text failed");
      }
      output = { match, screenshot: artifact, recognizedWordCount: words.length };
    } else if (type === "drag") {
      const x = requiredCoordinate(input, "x");
      const y = requiredCoordinate(input, "y");
      const toX = requiredCoordinate(input, "toX");
      const toY = requiredCoordinate(input, "toY");
      const button = optionalInteger(input.button) ?? 1;
      const result = await runCommand(
        "xdotool",
        [
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
        ],
        { home: session.profileHome }
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool drag failed");
      }
    } else if (type === "key") {
      const key = normalizeString(input.key);
      if (!key) {
        throw new Error("key requires key");
      }
      const result = await runCommand("xdotool", ["key", key], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool key failed");
      }
    } else if (type === "type") {
      const text = typeof input.text === "string" ? input.text : "";
      const result = await runCommand("xdotool", ["type", "--delay", String(input.delayMs ?? 10), text], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool type failed");
      }
    } else if (type === "window_list") {
      output = { windows: await getWindowList(session) };
    } else if (type === "focus_window") {
      const windowId = normalizeString(input.windowId);
      if (!windowId) {
        throw new Error("focus_window requires windowId");
      }
      const result = await runCommand("xdotool", ["windowactivate", "--sync", windowId], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool windowactivate failed");
      }
    } else if (type === "close_window") {
      const windowId = normalizeString(input.windowId);
      if (!windowId) {
        throw new Error("close_window requires windowId");
      }
      const result = await runCommand("xdotool", ["windowclose", windowId], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xdotool windowclose failed");
      }
    } else if (type === "clipboard_set") {
      const text = typeof input.text === "string" ? input.text : "";
      await setClipboard(text, session.profileHome);
    } else if (type === "clipboard_get") {
      const result = await runCommand("xclip", ["-selection", "clipboard", "-out"], { home: session.profileHome });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "xclip clipboard_get failed");
      }
      output = { text: result.stdout };
    } else if (type === "cdp_targets") {
      output = await getCdpTargets(input);
    } else if (type === "cdp_accessibility") {
      output = await runCdpAccessibility(input);
    } else {
      throw new Error(`Unsupported desktop action: ${type}`);
    }

    const durationMs = Math.max(0, now() - startedAt);
    session.actions.push({
      type,
      actor,
      at: now(),
      durationMs,
      status: "completed",
      input: summarizeActionInput(input),
      output
    });
    session.lastActivityAt = now();
    return {
      ok: true,
      action: { type, durationMs, output },
      state: sessionSummary(session)
    };
  } catch (error) {
    const durationMs = Math.max(0, now() - startedAt);
    session.actions.push({
      type,
      actor,
      at: now(),
      durationMs,
      status: "failed",
      input: summarizeActionInput(input),
      error: error instanceof Error ? error.message : String(error)
    });
    session.lastActivityAt = now();
    throw error;
  }
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
  await fs.writeFile(session.actionLogPath, `${JSON.stringify(session.actions, null, 2)}\n`, "utf8");
  const artifacts = await collectArtifacts([
    { kind: "manifest", label: "Manifest", filePath: session.manifestPath, contentType: "application/json" },
    ...session.screenshotArtifacts,
    { kind: "other", label: "Action log", filePath: session.actionLogPath, contentType: "application/json" },
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
    workspace: {
      key: session.workspaceKey,
      name: session.workspaceName,
      index: session.workspaceIndex
    },
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
    if (session.interactive) {
      continue;
    }
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
        desktopProfilesDir,
        vncUrl: `http://127.0.0.1:${process.env.MANOR_DESKTOP_PROOF_VNC_PORT ?? "6080"}/vnc.html`,
        activeSessionCount: sessions.size
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      writeJson(response, 200, { ok: true, sessions: [...sessions.values()].map((session) => sessionSummary(session)) });
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
