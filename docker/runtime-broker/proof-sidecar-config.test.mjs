import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const brokerSource = readFileSync(new URL("./broker.mjs", import.meta.url), "utf8");
const composeSource = readFileSync(new URL("../../compose.yml", import.meta.url), "utf8");

test("runtime broker defaults to the Playwright compose service DNS name", () => {
  assert.match(
    brokerSource,
    /RUNTIME_PLAYWRIGHT_CONTROL_URL \?\? "http:\/\/playwright:3777"/,
    "default control URL should use the compose service hostname"
  );
});

test("compose wires runtime-broker to the resolvable Playwright service hostname", () => {
  assert.match(composeSource, /RUNTIME_PLAYWRIGHT_CONTROL_URL: http:\/\/playwright:3777/);
  assert.match(composeSource, /NO_PROXY: .*\bplaywright\b/);
  assert.doesNotMatch(composeSource, /RUNTIME_PLAYWRIGHT_CONTROL_URL: http:\/\/manor-playwright:3777/);
});
