import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { mergeSkillCatalogs, SkillsDashboard } from "../../src/web/SkillsDashboard.js";

test("skills settings leads with Butler and keeps manual tools secondary", () => {
  const markup = renderToStaticMarkup(React.createElement(SkillsDashboard, { active: true }));

  assert.match(markup, /Ask Butler to add a skill/);
  assert.match(markup, /href="\/\?ask=add-skill"/);
  assert.match(markup, /one shared skill registry/i);
  assert.match(markup, /Search installed skills/);
  assert.doesNotMatch(markup, /Skill environments/);
  assert.match(markup, /<summary>Advanced<\/summary>/);
  assert.doesNotMatch(markup, /skills-content/);
});

test("skills settings presents duplicate environment entries as one capability", () => {
  const base = {
    id: "shared-skill",
    name: "shared-skill",
    description: "A shared capability",
    scope: "user" as const,
    origin: "local" as const,
    mutable: true,
    invocation: "/skill:shared-skill"
  };
  const merged = mergeSkillCatalogs([
    [{ ...base, environment: "butler-pi" }],
    [{ ...base, environment: "worker-pi" }]
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.environments, ["butler-pi", "worker-pi"]);
});
