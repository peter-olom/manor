import assert from "node:assert/strict";
import test from "node:test";

import { listPiComposerCommands } from "../../src/server/pi-composer-commands.js";

test("Pi composer commands include executable extensions and prompt templates with collision precedence", () => {
  const session = {
    extensionRunner: {
      getRegisteredCommands: () => [
        { invocationName: "review", description: "Extension review" },
        { invocationName: "ship", description: "Ship changes" }
      ]
    },
    promptTemplates: [
      { name: "review", description: "Prompt review" },
      { name: "explain", description: "Explain changes" }
    ]
  };
  assert.deepEqual(listPiComposerCommands(session as never), [
    { name: "review", description: "Extension review", source: "extension" },
    { name: "ship", description: "Ship changes", source: "extension" },
    { name: "explain", description: "Explain changes", source: "prompt" }
  ]);
});
