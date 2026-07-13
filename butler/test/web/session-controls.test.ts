import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionControlsButton } from "../../src/web/WorkerSessionControls.js";

test("Butler sessions expose an explicitly labelled session controls entry point", () => {
  const markup = renderToStaticMarkup(React.createElement(SessionControlsButton, {
    pairId: "pair-1",
    lane: "butler",
    disabled: false
  }));
  assert.match(markup, />Session controls</);
  assert.doesNotMatch(markup, /disabled/);
});
