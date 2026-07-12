import assert from "node:assert/strict";
import test from "node:test";

import {
  canBeginPairDeletion,
  reconcileSelectedPairId,
  shouldClearDeletedPairSelection,
  shouldReportPairDetailError
} from "../../src/web/pair-selection.js";

test("pair selection keeps a session that still exists", () => {
  assert.equal(reconcileSelectedPairId("pair-b", [{ id: "pair-a" }, { id: "pair-b" }]), "pair-b");
});

test("pair selection moves to the first remaining session when the current one disappears", () => {
  assert.equal(reconcileSelectedPairId("pair-a", [{ id: "pair-b" }, { id: "pair-c" }]), "pair-b");
});

test("pair selection clears when no sessions remain", () => {
  assert.equal(reconcileSelectedPairId("pair-a", []), null);
});

test("detail errors from a deleting or stale session stay hidden", () => {
  assert.equal(shouldReportPairDetailError("pair-a", "pair-a", new Set(["pair-a"])), false);
  assert.equal(shouldReportPairDetailError("pair-a", "pair-b", new Set()), false);
  assert.equal(shouldReportPairDetailError("pair-b", "pair-b", new Set()), true);
});

test("a slow delete stays suppressed across switch-away and switch-back races", () => {
  const suppressed = new Set(["pair-a"]);
  let selectedPairId: string | null = "pair-a";

  selectedPairId = "pair-b";
  assert.equal(shouldClearDeletedPairSelection("pair-a", selectedPairId), false);
  selectedPairId = "pair-a";
  assert.equal(shouldReportPairDetailError("pair-a", selectedPairId, suppressed), false);

  if (shouldClearDeletedPairSelection("pair-a", selectedPairId)) selectedPairId = null;
  suppressed.delete("pair-a");
  assert.equal(shouldReportPairDetailError("pair-a", selectedPairId, suppressed), false);
});

test("duplicate delete attempts cannot share and prematurely release suppression", () => {
  const deleting = new Set<string>();
  assert.equal(canBeginPairDeletion("pair-a", deleting), true);
  deleting.add("pair-a");
  assert.equal(canBeginPairDeletion("pair-a", deleting), false);
  assert.equal(canBeginPairDeletion("pair-b", deleting), true);
});
