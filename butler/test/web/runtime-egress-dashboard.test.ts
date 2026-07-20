import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RuntimeEgressDashboard } from "../../src/web/RuntimeEgressDashboard.js";
import { SETTINGS_SECTIONS } from "../../src/web/SettingsDashboard.js";

test("runtime egress settings makes the shared scope and primary action clear", () => {
  const markup = renderToStaticMarkup(React.createElement(RuntimeEgressDashboard, { active: true }));

  assert.match(markup, /Runtime egress/);
  assert.match(markup, /Butler and Worker/);
  assert.match(markup, /Allow hostname/);
  assert.match(markup, /Include subdomains/);
  assert.match(markup, /Built-in Restricted-mode access/);
  assert.match(markup, /Egress control applies to/);
  assert.match(markup, /Egress control does not apply to/);
  assert.match(markup, /Butler software can also bypass it/);
  assert.match(markup, /Loading current policy/);
  assert.equal(SETTINGS_SECTIONS.some((section) => section.id === "network"), false);
  assert.equal(SETTINGS_SECTIONS.some((section) => section.id === "security" && section.description.includes("runtime egress")), true);
});
