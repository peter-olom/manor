import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("preview verification summary surfaces non-none failure kinds as signal text", () => {
  const source = readFileSync(resolve(webRoot, "PreviewVerificationSummary.tsx"), "utf8");

  assert.match(source, /verification\.failureKind !== "none" \? `Signal: \$\{verification\.failureKind\}` : null/);
  assert.match(source, /const compactSummary = issueLines\[0\]/);
});
