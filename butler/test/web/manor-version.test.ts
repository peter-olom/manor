import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ManorVersion } from "../../src/web/ManorVersion.js";

test("Manor version renders as quiet brand metadata", () => {
  const markup = renderToStaticMarkup(React.createElement(ManorVersion, { version: "0.1.0" }));
  assert.match(markup, /class="brand-version"/);
  assert.match(markup, /title="Manor version 0.1.0"/);
  assert.match(markup, />v0.1.0</);
});
