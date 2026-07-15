import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MANOR_VERSION } from "../../src/server/manor-version.js";

test("server version matches the canonical package version", () => {
  const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(MANOR_VERSION, packageMetadata.version);
});
