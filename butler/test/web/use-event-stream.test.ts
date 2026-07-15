import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the UI subscribes to live events without requesting global state snapshots", () => {
  const source = readFileSync(new URL("../../src/web/useEventStream.ts", import.meta.url), "utf8");
  assert.match(source, /new EventSource\("\/api\/events\?state="\)/);
  assert.doesNotMatch(source, /state=runtime/);
});
