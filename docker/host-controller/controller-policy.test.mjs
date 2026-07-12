import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRestartDelayMs,
  normalizeRestartWaitTimeoutSeconds,
  safeTokenMatch,
  shouldBuildSourceImages,
  validateRestartPayload
} from "./controller-policy.mjs";

test("restart policy accepts a minimal confirmed restart", () => {
  const parsed = validateRestartPayload({ confirmation: "restart Manor" });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    target: "current",
    gitRef: null,
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

test("restart policy accepts source update inputs", () => {
  const source = validateRestartPayload({ confirmation: "restart Manor", gitRef: "origin/main" });
  assert.equal(source.ok, true);

  const sourceHotReload = validateRestartPayload({ confirmation: "restart Manor", hotReload: true });
  assert.equal(sourceHotReload.ok, true);
});

test("source restarts build current source by default", () => {
  assert.equal(shouldBuildSourceImages({ target: "current", update: false }), true);
  assert.equal(shouldBuildSourceImages({ target: "current", update: false, build: true }), true);
  assert.equal(shouldBuildSourceImages({ target: "current", update: false, build: false }), false);
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
