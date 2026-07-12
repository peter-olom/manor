import crypto from "node:crypto";

const restartKeys = new Set([
  "confirmation",
  "target",
  "gitRef",
  "includeDesktop",
  "hotReload",
  "build",
  "update"
]);

const targetValues = new Set(["current", "latest"]);
const gitRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$/;

export function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value, label) {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${label} must be a string.` };
  }
  return { ok: true, value: normalizeString(value) || null };
}

function optionalBoolean(value, label) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "boolean") {
    return { ok: false, error: `${label} must be true or false.` };
  }
  return { ok: true, value };
}

export function safeTokenMatch(expected, provided) {
  if (typeof expected !== "string" || expected.length < 32 || typeof provided !== "string") {
    return false;
  }
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  return crypto.timingSafeEqual(expectedHash, providedHash);
}

export function normalizeRestartDelayMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 2500;
  }
  return Math.max(0, Math.min(30_000, Math.trunc(parsed)));
}

export function normalizeRestartWaitTimeoutSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 300;
  }
  return Math.max(30, Math.min(900, Math.trunc(parsed)));
}

export function shouldBuildSourceImages(payload) {
  return payload.build !== false;
}

export function validateGitRef(value) {
  if (!gitRefPattern.test(value)) {
    return false;
  }
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{")
  ) {
    return false;
  }
  return true;
}

export function validateRestartPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: "Restart request must be a JSON object." };
  }

  const unknownKeys = Object.keys(payload).filter((key) => !restartKeys.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unsupported restart field: ${unknownKeys[0]}.` };
  }

  if (payload.confirmation !== "restart Manor") {
    return { ok: false, error: "confirmation must be exactly: restart Manor" };
  }

  const target = normalizeString(payload.target) || "current";
  if (!targetValues.has(target)) {
    return { ok: false, error: "target must be one of: current, latest" };
  }

  const gitRef = optionalString(payload.gitRef, "gitRef");
  if (!gitRef.ok) {
    return gitRef;
  }
  if (gitRef.value && !validateGitRef(gitRef.value)) {
    return { ok: false, error: "gitRef must be a safe branch, tag, or commit reference." };
  }

  if (gitRef.value && target === "latest") {
    return { ok: false, error: "Use either target latest or a specific gitRef, not both." };
  }

  const includeDesktop = optionalBoolean(payload.includeDesktop, "includeDesktop");
  if (!includeDesktop.ok) {
    return includeDesktop;
  }

  const hotReload = optionalBoolean(payload.hotReload, "hotReload");
  if (!hotReload.ok) {
    return hotReload;
  }

  const build = optionalBoolean(payload.build, "build");
  if (!build.ok) {
    return build;
  }

  const update = optionalBoolean(payload.update, "update");
  if (!update.ok) {
    return update;
  }

  return {
    ok: true,
    value: {
      target,
      gitRef: gitRef.value,
      includeDesktop: includeDesktop.value === true,
      hotReload: hotReload.value,
      build: build.value,
      update: update.value === true
    }
  };
}
