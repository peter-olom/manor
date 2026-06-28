import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const brokerSource = await readFile(new URL("./broker.mjs", import.meta.url), "utf8");
const composeSource = await readFile(new URL("../../compose.yml", import.meta.url), "utf8");

function serviceBlock(serviceName) {
  const match = composeSource.match(new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|\\nnetworks:)`));
  assert.ok(match, `service ${serviceName} should exist`);
  return match[1];
}

test("runtime broker uses the Playwright compose service hostname", () => {
  assert.match(brokerSource, /RUNTIME_PLAYWRIGHT_CONTROL_URL \?\? "http:\/\/playwright:3777"/);
  assert.match(serviceBlock("runtime-broker"), /RUNTIME_PLAYWRIGHT_CONTROL_URL: http:\/\/playwright:3777/);
});

test("Playwright proof sidecar is required, restartable, and health checked", () => {
  const block = serviceBlock("playwright");
  assert.match(block, /restart: unless-stopped/);
  assert.match(block, /healthcheck:/);
  assert.match(block, /http:\/\/127\.0\.0\.1:3777\/health/);
});

test("desktop proof sidecar remains optional but restartable when enabled", () => {
  const block = serviceBlock("desktop-proof");
  assert.match(block, /profiles: \["desktop"\]/);
  assert.match(block, /restart: unless-stopped/);
  assert.match(block, /healthcheck:/);
  assert.match(block, /http:\/\/127\.0\.0\.1:3888\/health/);
});
