import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, "../../src/web");

test("requested reasoning effort is not rendered as a separate badge", () => {
  const sources = [
    readFileSync(resolve(webRoot, "App.tsx"), "utf8"),
    readFileSync(resolve(webRoot, "ThreadSurface.tsx"), "utf8"),
    readFileSync(resolve(webRoot, "styles.css"), "utf8")
  ].join("\n");

  assert.equal(sources.includes("thread-effort-badge"), false);
  assert.equal(sources.includes("Delegated reasoning:"), false);
});
