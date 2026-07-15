import assert from "node:assert/strict";
import test from "node:test";

import {
  readSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  writeSidebarCollapsed,
  type SidebarPreferenceStore
} from "../../src/web/sidebar-preference.js";

function preferenceStore(initial: string | null = null): { store: SidebarPreferenceStore; values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== null) values.set(SIDEBAR_COLLAPSED_STORAGE_KEY, initial);
  return {
    values,
    store: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    }
  };
}

test("sidebar starts expanded unless the collapsed preference is explicit", () => {
  assert.equal(readSidebarCollapsed(preferenceStore().store), false);
  assert.equal(readSidebarCollapsed(preferenceStore("false").store), false);
  assert.equal(readSidebarCollapsed(preferenceStore("true").store), true);
});

test("sidebar collapse preference persists", () => {
  const { store, values } = preferenceStore();
  writeSidebarCollapsed(true, store);
  assert.equal(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY), "true");
  writeSidebarCollapsed(false, store);
  assert.equal(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY), "false");
});

test("sidebar preference tolerates unavailable browser storage", () => {
  const unavailable: SidebarPreferenceStore = {
    getItem: () => { throw new Error("unavailable"); },
    setItem: () => { throw new Error("unavailable"); }
  };
  assert.equal(readSidebarCollapsed(unavailable), false);
  assert.doesNotThrow(() => writeSidebarCollapsed(true, unavailable));
  assert.equal(readSidebarCollapsed(), false);
  assert.doesNotThrow(() => writeSidebarCollapsed(true));
});
