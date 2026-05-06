import test from "node:test";
import assert from "node:assert/strict";

import { deleteButlerSessionChatFrom } from "../../src/server/butler-agent-chat-hygiene.js";

test("Butler chat deletion uses string message timestamps for activity cleanup", () => {
  const createdAt = "2026-05-06T20:00:00.000Z";
  let branchedFrom: string | null = null;
  const session = {
    messages: [{ role: "user", createdAt }],
    sessionManager: {
      getBranch() {
        return [
          { id: "root-entry", type: "session_info" },
          { id: "target-entry", type: "message" }
        ];
      },
      createBranchedSession(entryId: string) {
        branchedFrom = entryId;
      },
      buildSessionContext() {
        return { messages: [] };
      }
    },
    agent: {
      state: {
        messages: [{ role: "user", createdAt }]
      }
    }
  };

  assert.equal(deleteButlerSessionChatFrom(session as never, "message-0"), Date.parse(createdAt));
  assert.equal(branchedFrom, "root-entry");
});
