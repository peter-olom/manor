import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillsDashboard } from "../../src/web/SkillsDashboard.js";

test("skills settings leads with Butler and keeps manual tools secondary", () => {
  const markup = renderToStaticMarkup(React.createElement(SkillsDashboard, { active: true }));

  assert.match(markup, /Ask Butler to add a skill/);
  assert.match(markup, /href="\/\?ask=add-skill"/);
  assert.match(markup, /Search installed skills/);
  assert.match(markup, /<summary>Advanced<\/summary>/);
  assert.doesNotMatch(markup, /skills-content/);
});
