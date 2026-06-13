import test from "node:test";
import assert from "node:assert/strict";

import {
  hasCommittedPendingButlerPrompt,
  reconcilePendingButlerPrompts,
  shouldShowPendingButlerPrompt,
  type PendingButlerPrompt
} from "../../src/web/utils.js";
import type { ButlerMessageRecord } from "../../src/web/types.js";

function message(id: string, role: string, text: string, at = Date.now()): ButlerMessageRecord {
  return { id, role, text, at, kind: "message" };
}

function pending(id: string, text: string, at = 1_000): PendingButlerPrompt {
  return { id, text, at };
}

test("pending Butler prompt remains until the matching user message is committed", () => {
  const pendingText = "Investigate the live-state race.";

  assert.equal(hasCommittedPendingButlerPrompt([], pendingText), false);
  assert.equal(hasCommittedPendingButlerPrompt([message("assistant-1", "assistant", pendingText)], pendingText), false);
  assert.equal(hasCommittedPendingButlerPrompt([message("user-1", "user", "Different prompt")], pendingText), false);
  assert.equal(hasCommittedPendingButlerPrompt([message("user-2", "user", pendingText)], pendingText), true);
});

test("pending Butler prompt stays visible when live history lacks the committed message", () => {
  assert.equal(shouldShowPendingButlerPrompt("keep me visible", [message("older", "assistant", "previous reply")]), true);
});

test("pending Butler prompt is hidden once the committed user message appears", () => {
  assert.equal(
    shouldShowPendingButlerPrompt("replace me", [message("older", "assistant", "previous reply"), message("committed", "user", "replace me")]),
    false
  );
});

test("assistant text matching a pending Butler prompt does not replace the user prompt", () => {
  assert.equal(shouldShowPendingButlerPrompt("same text", [message("assistant", "assistant", "same text")]), true);
});

test("committed Butler prompts loaded from pages also replace pending prompts", () => {
  assert.deepEqual(
    reconcilePendingButlerPrompts(
      [message("committed", "user", "from loaded page", 1_500), message("latest", "assistant", "newer reply", 2_000)],
      [pending("p1", "from loaded page", 1_000)]
    ),
    []
  );
});

test("unrelated stale snapshots preserve all pending Butler prompts", () => {
  assert.deepEqual(
    reconcilePendingButlerPrompts(
      [message("older-user", "user", "older unrelated prompt", 1_500), message("assistant", "assistant", "first pending", 1_600)],
      [pending("p1", "first pending", 2_000), pending("p2", "second pending", 2_100)]
    ),
    [pending("p1", "first pending", 2_000), pending("p2", "second pending", 2_100)]
  );
});

test("repeated quick sends keep earlier pending prompts visible until each commit arrives", () => {
  assert.deepEqual(
    reconcilePendingButlerPrompts([message("assistant", "assistant", "previous reply", 1_000)], [
      pending("p1", "first pending", 2_000),
      pending("p2", "second pending", 2_100)
    ]),
    [pending("p1", "first pending", 2_000), pending("p2", "second pending", 2_100)]
  );
});

test("committed replacement removes one matching pending prompt without duplicating user rows", () => {
  assert.deepEqual(reconcilePendingButlerPrompts([message("u1", "user", "commit me", 1_200)], [pending("p1", "commit me", 1_000)]), []);
});

test("duplicate pending prompts with the same text are reconciled one committed message at a time", () => {
  assert.deepEqual(
    reconcilePendingButlerPrompts([message("u1", "user", "same", 1_200)], [pending("p1", "same", 1_000), pending("p2", "same", 1_100)]),
    [pending("p2", "same", 1_100)]
  );

  assert.deepEqual(
    reconcilePendingButlerPrompts(
      [message("u1", "user", "same", 1_200), message("u2", "user", "same", 1_300)],
      [pending("p1", "same", 1_000), pending("p2", "same", 1_100)]
    ),
    []
  );
});
