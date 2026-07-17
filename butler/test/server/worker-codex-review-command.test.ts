import test from "node:test";
import assert from "node:assert/strict";

import { isolatedModelResourceOptions } from "../../src/server/isolated-model-resources.js";

test("isolated review sessions disable ambient Pi resources", () => {
  const options = isolatedModelResourceOptions();
  assert.equal(options.noExtensions, true);
  assert.equal(options.noSkills, true);
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.noThemes, true);
  assert.equal(options.noContextFiles, true);
  assert.deepEqual(options.appendSystemPromptOverride(), []);
});
