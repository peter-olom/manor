import test from "node:test";
import assert from "node:assert/strict";

import { formatRequestedReasoningEffort } from "../../src/web/utils.js";

test("requested reasoning effort badge label distinguishes delegated effort", () => {
  assert.equal(formatRequestedReasoningEffort("xhigh"), "Delegated reasoning: xhigh");
  assert.equal(formatRequestedReasoningEffort(null), null);
});
