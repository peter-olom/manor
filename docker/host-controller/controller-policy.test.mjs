import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRuntimeRestartMode,
  normalizeRestartDelayMs,
  normalizeRestartWaitTimeoutSeconds,
  safeTokenMatch,
  shouldBuildSourceImages,
  validateImageTag,
  validateRestartModeScope,
  validateRestartPayload
} from "./controller-policy.mjs";

test("restart policy accepts a minimal confirmed restart", () => {
  const parsed = validateRestartPayload({ confirmation: "restart Manor" });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    requestedMode: "auto",
    target: "current",
    gitRef: null,
    imageTag: null,
    includeDesktop: false,
    hotReload: undefined,
    build: undefined,
    update: false
  });
});

test("restart policy rejects unsupported fields and unsafe refs", () => {
  assert.equal(validateRestartPayload({ confirmation: "restart Manor", services: ["butler"] }).ok, false);
  assert.equal(validateRestartPayload({ confirmation: "restart Manor", delayMs: 1 }).ok, false);
  assert.equal(validateRestartPayload({ confirmation: "restart Manor", gitRef: "-B" }).ok, false);
  assert.equal(validateRestartPayload({ confirmation: "restart Manor", gitRef: "feature..main" }).ok, false);
  assert.equal(validateRestartPayload({ confirmation: "restart Manor", gitRef: "main;rm" }).ok, false);
});

test("restart policy scopes source and image inputs to detected mode", () => {
  const source = validateRestartPayload({ confirmation: "restart Manor", mode: "source", gitRef: "origin/main" });
  assert.equal(source.ok, true);
  assert.equal(validateRestartModeScope(source.value, "source").ok, true);
  assert.equal(validateRestartModeScope(source.value, "image").ok, false);

  const image = validateRestartPayload({ confirmation: "restart Manor", mode: "image", imageTag: "v1.2.3" });
  assert.equal(image.ok, true);
  assert.equal(validateRestartModeScope(image.value, "image").ok, true);
  assert.equal(validateRestartModeScope(image.value, "source").ok, false);

  const imageBuild = validateRestartPayload({ confirmation: "restart Manor", mode: "image", build: false });
  assert.equal(imageBuild.ok, true);
  assert.equal(validateRestartModeScope(imageBuild.value, "image").ok, true);

  const imageBuildTrue = validateRestartPayload({ confirmation: "restart Manor", mode: "image", build: true });
  assert.equal(imageBuildTrue.ok, true);
  assert.equal(validateRestartModeScope(imageBuildTrue.value, "image").ok, false);

  const sourceHotReload = validateRestartPayload({ confirmation: "restart Manor", mode: "source", hotReload: true });
  assert.equal(sourceHotReload.ok, true);
  assert.equal(validateRestartModeScope(sourceHotReload.value, "source").ok, true);
  assert.equal(validateRestartModeScope(sourceHotReload.value, "image").ok, false);
});

test("runtime mode detection requires explicit source mode", () => {
  assert.equal(detectRuntimeRestartMode("1"), "source");
  assert.equal(detectRuntimeRestartMode("0"), "image");
  assert.equal(detectRuntimeRestartMode(""), "image");
});

test("source restarts build current source by default", () => {
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "current", update: false }), true);
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "current", update: false, build: true }), true);
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "current", update: false, build: false }), false);
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "latest", update: false }), true);
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "current", update: true }), true);
  assert.equal(shouldBuildSourceImages({ mode: "source", target: "current", update: false, gitRef: "main" }), true);
});

test("restart policy only accepts image tags, not image references", () => {
  assert.equal(validateImageTag("latest"), true);
  assert.equal(validateImageTag("sha-abcdef"), true);
  assert.equal(validateImageTag("ghcr.io/peter-olom/manor-butler:latest"), false);
});

test("restart token matching requires the scoped token", () => {
  const token = "a".repeat(64);

  assert.equal(safeTokenMatch(token, token), true);
  assert.equal(safeTokenMatch(token, "b".repeat(64)), false);
  assert.equal(safeTokenMatch("short", "short"), false);
  assert.equal(safeTokenMatch(token, undefined), false);
});

test("restart delay is bounded", () => {
  assert.equal(normalizeRestartDelayMs("1000"), 1000);
  assert.equal(normalizeRestartDelayMs("-10"), 0);
  assert.equal(normalizeRestartDelayMs("999999"), 30000);
  assert.equal(normalizeRestartDelayMs("bad"), 2500);
});

test("restart health wait is bounded", () => {
  assert.equal(normalizeRestartWaitTimeoutSeconds("300"), 300);
  assert.equal(normalizeRestartWaitTimeoutSeconds("1"), 30);
  assert.equal(normalizeRestartWaitTimeoutSeconds("9999"), 900);
  assert.equal(normalizeRestartWaitTimeoutSeconds("bad"), 300);
});
