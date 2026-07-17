import assert from "node:assert/strict";
import test from "node:test";

import { classifyReleaseCommit, resolveReleaseBump } from "../../scripts/resolve-release-bump.mjs";

test("release bump classifies conventional and plain-English commit subjects", () => {
  assert.equal(classifyReleaseCommit({ subject: "Fix session overflow", body: "" }), "patch");
  assert.equal(classifyReleaseCommit({ subject: "feat: add mobile navigation", body: "" }), "minor");
  assert.equal(classifyReleaseCommit({ subject: "Add operator timezone scheduling", body: "" }), "minor");
  assert.equal(classifyReleaseCommit({ subject: "feat!: replace the settings contract", body: "" }), "major");
  assert.equal(classifyReleaseCommit({ subject: "Refactor settings", body: "BREAKING CHANGE: remove legacy keys" }), "major");
});

test("Release-As overrides inference and the highest unreleased bump wins", () => {
  assert.equal(classifyReleaseCommit({ subject: "Fix compatibility", body: "Release-As: minor" }), "minor");
  assert.equal(resolveReleaseBump([
    { subject: "Fix compatibility", body: "" },
    { subject: "Support mobile navigation", body: "" },
    { subject: "Document migration", body: "Release-As: major" }
  ]), "major");
});
