import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTransientRegistryFailure,
  normalizeRestartDelayMs,
  normalizeRestartWaitTimeoutSeconds,
  retryTransientRegistryOperation,
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

test("transient registry failures are classified narrowly", () => {
  assert.equal(classifyTransientRegistryFailure('failed to fetch anonymous token: dial tcp: lookup auth.docker.io on 127.0.0.11:53: server misbehaving'), "registry_dns");
  assert.equal(classifyTransientRegistryFailure("failed to load metadata for docker.io/library/node:24: TLS handshake timeout"), "registry_connection");
  assert.equal(classifyTransientRegistryFailure("failed to resolve source metadata for docker.io/library/node:24: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/24: 503 Service Unavailable"), "registry_5xx");

  assert.equal(classifyTransientRegistryFailure("pull access denied: unauthorized"), null);
  assert.equal(classifyTransientRegistryFailure("manifest unknown: not found"), null);
  assert.equal(classifyTransientRegistryFailure("Dockerfile parse error on line 4"), null);
  assert.equal(classifyTransientRegistryFailure("npm request failed with EAI_AGAIN"), null);
  assert.equal(classifyTransientRegistryFailure("failed to load metadata: too many requests (429)"), null);
  assert.equal(classifyTransientRegistryFailure("loaded metadata for docker.io/library/node:24\napplication tests failed: unexpected EOF"), null);
});

test("transient registry operations retry with bounded delays", async () => {
  const waits = [];
  let attempts = 0;
  const result = await retryTransientRegistryOperation(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("transient");
    return "built";
  }, {
    delaysMs: [2, 5],
    failureOutput: () => "failed to fetch anonymous token from auth.docker.io: context deadline exceeded",
    waitForRetry: async (retry) => { waits.push(retry); }
  });

  assert.equal(result, "built");
  assert.equal(attempts, 3);
  assert.deepEqual(waits.map((entry) => entry.delayMs), [2, 5]);
  assert.deepEqual(waits.map((entry) => entry.reason), ["registry_connection", "registry_connection"]);
});

test("registry retry stops immediately for permanent failures and after exhaustion", async () => {
  let permanentAttempts = 0;
  await assert.rejects(() => retryTransientRegistryOperation(async () => {
    permanentAttempts += 1;
    throw new Error("permanent");
  }, {
    delaysMs: [0, 0],
    failureOutput: () => "failed to load metadata: pull access denied: unauthorized"
  }), /permanent/);
  assert.equal(permanentAttempts, 1);

  let transientAttempts = 0;
  await assert.rejects(() => retryTransientRegistryOperation(async () => {
    transientAttempts += 1;
    throw new Error("transient");
  }, {
    delaysMs: [0, 0],
    failureOutput: () => "failed to fetch anonymous token from auth.docker.io: no such host"
  }), /transient/);
  assert.equal(transientAttempts, 3);
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
