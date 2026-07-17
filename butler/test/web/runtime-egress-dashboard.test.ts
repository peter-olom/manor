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
  assert.match(markup, /Built-in access/);
  assert.equal(SETTINGS_SECTIONS.some((section) => section.id === "network" && section.label === "Network"), true);
});
