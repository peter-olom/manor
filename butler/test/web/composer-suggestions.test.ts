import assert from "node:assert/strict";
import test from "node:test";

import { addComposerContextItem, applyComposerSuggestion, composerItemKey, findComposerTrigger } from "../../src/web/composer-suggestions.js";

test("composer trigger detection recognizes files, skills, and leading commands", () => {
  assert.deepEqual(findComposerTrigger("Review @src/web", 15), { trigger: "@", query: "src/web", start: 7, end: 15 });
  assert.deepEqual(findComposerTrigger("Use $review", 11), { trigger: "$", query: "review", start: 4, end: 11 });
  assert.deepEqual(findComposerTrigger("/skill:review", 13), { trigger: "/", query: "skill:review", start: 0, end: 13 });
  assert.equal(findComposerTrigger("Explain /compact", 16), null);
});

test("context suggestions become structured chips without leaving a duplicate token", () => {
  const match = findComposerTrigger("Check @pair", 11)!;
  const result = applyComposerSuggestion("Check @pair", match, {
    id: "file:/repos/pair.ts",
    kind: "file",
    label: "pair.ts",
    detail: "src/pair.ts",
    insertText: "@src/pair.ts",
    inputItem: { type: "file", name: "src/pair.ts", path: "/repos/src/pair.ts" }
  });
  assert.equal(result.value, "Check ");
  assert.deepEqual(result.inputItem, { type: "file", name: "src/pair.ts", path: "/repos/src/pair.ts" });
  assert.equal(composerItemKey(result.inputItem!), "file:/repos/src/pair.ts");
});

test("command suggestions stay in the prompt for Pi to execute", () => {
  const match = findComposerTrigger("/rev", 4)!;
  const result = applyComposerSuggestion("/rev", match, {
    id: "command:review",
    kind: "command",
    label: "/review",
    detail: "Review the current change",
    insertText: "/review"
  });
  assert.equal(result.value, "/review ");
  assert.equal(result.inputItem, null);
});

test("skill discovery actions replace the draft with a Butler request", () => {
  const match = findComposerTrigger("I need $release-notes", 21)!;
  const result = applyComposerSuggestion("I need $release-notes", match, {
    id: "action:find-or-create-skill:release-notes",
    kind: "action",
    label: "Find or create a skill for release-notes",
    detail: "Ask Butler to find an existing skill or create one with you.",
    insertText: "Find or create a skill for release-notes."
  });
  assert.equal(result.value, "Find or create a skill for release-notes.");
  assert.equal(result.caret, result.value.length);
  assert.equal(result.inputItem, null);
});

test("selecting another skill replaces the active skill while preserving file context", () => {
  const file = { type: "file" as const, name: "src/app.ts", path: "/repos/src/app.ts" };
  const review = { type: "skill" as const, name: "review", id: "skill-review", environment: "butler-pi" as const };
  const release = { type: "skill" as const, name: "release", id: "skill-release", environment: "butler-pi" as const };
  assert.deepEqual(addComposerContextItem(addComposerContextItem([file], review), release), [file, release]);
});
