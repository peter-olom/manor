import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchSkillInstallHandoff,
  listenForSkillInstallHandoff,
  readSkillInstallHandoff,
  removeSkillInstallHandoff,
  shouldCreateSkillInstallSession,
  SKILL_INSTALL_HANDOFF_PLACEHOLDER
} from "../../src/web/skill-install-handoff.js";

test("skill inventory handoff is transient intent rather than composer text", () => {
  assert.equal(readSkillInstallHandoff("?ask=add-skill"), true);
  assert.equal(readSkillInstallHandoff("?ask=something-else"), false);
  assert.match(SKILL_INSTALL_HANDOFF_PLACEHOLDER, /describe the skill or capability/i);
});

test("skill inventory handoff is consumed without dropping other URL state", () => {
  assert.equal(
    removeSkillInstallHandoff("http://localhost:8180/?ask=add-skill&view=butler#composer"),
    "/?view=butler#composer"
  );
});

test("skill inventory handoff dispatches in-app without navigation", () => {
  const target = new EventTarget();
  let calls = 0;
  const stop = listenForSkillInstallHandoff(() => { calls += 1; }, target);
  dispatchSkillInstallHandoff(target);
  stop();
  dispatchSkillInstallHandoff(target);
  assert.equal(calls, 1);
});

test("skill inventory handoff creates a session only when none is active", () => {
  assert.equal(shouldCreateSkillInstallSession(null), true);
  assert.equal(shouldCreateSkillInstallSession(null, true), false);
  assert.equal(shouldCreateSkillInstallSession("pair-1"), false);
});
