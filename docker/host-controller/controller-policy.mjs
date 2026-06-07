import crypto from "node:crypto";

const restartKeys = new Set([
  "confirmation",
  "mode",
  "target",
  "gitRef",
  "imageTag",
  "includeDesktop",
  "build",
  "update"
]);

const modeValues = new Set(["auto", "source", "image"]);
const targetValues = new Set(["current", "latest"]);
const gitRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$/;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const sourceModeEnvValues = new Set(["1", "true", "yes", "on"]);
const localManorImagePattern = /^manor-[a-z0-9-]+:local$/;

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

export function detectRuntimeRestartMode(buildFromSource, imageReferences = []) {
  if (sourceModeEnvValues.has(String(buildFromSource ?? "").trim().toLowerCase())) {
    return "source";
  }
  return imageReferences.some((imageReference) => localManorImagePattern.test(String(imageReference ?? "").trim()))
    ? "source"
    : "image";
}

export function shouldBuildSourceImages(payload) {
  if (payload.build === true) {
    return true;
  }
  if (payload.build === false) {
    return false;
  }
  return payload.update === true || payload.target === "latest" || Boolean(payload.gitRef);
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

export function validateImageTag(value) {
  return imageTagPattern.test(value);
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

  const requestedMode = normalizeString(payload.mode) || "auto";
  if (!modeValues.has(requestedMode)) {
    return { ok: false, error: "mode must be one of: auto, source, image" };
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

  const imageTag = optionalString(payload.imageTag, "imageTag");
  if (!imageTag.ok) {
    return imageTag;
  }
  if (imageTag.value && !validateImageTag(imageTag.value)) {
    return { ok: false, error: "imageTag must be a Docker image tag, not a full image reference." };
  }

  if (gitRef.value && imageTag.value) {
    return { ok: false, error: "Specify gitRef for source mode or imageTag for image mode, not both." };
  }

  if ((gitRef.value || imageTag.value) && target === "latest") {
    return { ok: false, error: "Use either target latest or a specific gitRef/imageTag, not both." };
  }

  const includeDesktop = optionalBoolean(payload.includeDesktop, "includeDesktop");
  if (!includeDesktop.ok) {
    return includeDesktop;
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
      requestedMode,
      target,
      gitRef: gitRef.value,
      imageTag: imageTag.value,
      includeDesktop: includeDesktop.value === true,
      build: build.value,
      update: update.value === true
    }
  };
}

export function validateRestartModeScope(payload, mode) {
  if (payload.gitRef && mode !== "source") {
    return { ok: false, error: "gitRef is only allowed when the detected restart mode is source." };
  }
  if (payload.imageTag && mode !== "image") {
    return { ok: false, error: "imageTag is only allowed when the detected restart mode is image." };
  }
  if (payload.build === true && mode !== "source") {
    return { ok: false, error: "build true is only allowed when the detected restart mode is source." };
  }
  return { ok: true, value: { ...payload, mode } };
}
