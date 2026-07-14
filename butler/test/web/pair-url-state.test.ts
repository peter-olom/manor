import assert from "node:assert/strict";
import test from "node:test";

import { buildPairUrl, readPairUrlState, writePairUrl, type PairUrlHistory } from "../../src/web/pair-url-state.js";

test("session selection is read from the URL", () => {
  const state = readPairUrlState("http://manor.local/?session=pair-b&view=worker");
  assert.equal(state.sessionId, "pair-b");
  assert.equal(state.viewMode, "worker");
});

test("session selection is written without losing the active view", () => {
  const state = readPairUrlState("http://manor.local/?view=split");
  assert.equal(buildPairUrl("http://manor.local/?view=split", { ...state, sessionId: "pair-b" }), "/?view=split&session=pair-b");
});

test("clearing session selection removes it from the URL", () => {
  const state = readPairUrlState("http://manor.local/?session=pair-b");
  assert.equal(buildPairUrl("http://manor.local/?session=pair-b", { ...state, sessionId: null }), "/");
});

test("settings URLs retain the selected session", () => {
  const state = readPairUrlState("http://manor.local/settings/providers?session=pair-b&provider=ollama");
  assert.equal(state.sessionId, "pair-b");
  assert.equal(state.settingsSection, "providers");
  assert.equal(buildPairUrl("http://manor.local/settings/providers?session=pair-b&provider=ollama", state), "/settings/providers?session=pair-b&provider=ollama");
});

test("user-driven session changes push a history entry", () => {
  const calls: string[] = [];
  const history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => calls.push(`push:${url}`),
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => calls.push(`replace:${url}`)
  } as PairUrlHistory;
  const state = readPairUrlState("http://manor.local/?session=pair-a");

  writePairUrl(history, "http://manor.local/?session=pair-a", { ...state, sessionId: "pair-b" }, "push");
  writePairUrl(history, "http://manor.local/?session=missing", { ...state, sessionId: "pair-a" }, "replace");

  assert.deepEqual(calls, ["push:/?session=pair-b", "replace:/?session=pair-a"]);
});
