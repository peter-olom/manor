import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ManorRestartProgressDialog, resolveManorRestartProgressPhase } from "../../src/web/ManorRestartProgressDialog.js";
import type { ManorRestartProgressView } from "../../src/shared/manor-restart.js";

function progress(status: ManorRestartProgressView["status"]): ManorRestartProgressView {
  return {
    requestId: "request-1",
    runId: "run-1",
    startedAt: 1,
    status,
    completedAt: status === "completed" ? 2 : null,
    currentStep: status === "running" ? "Restart Butler" : null,
    error: status === "failed" ? "The host controller could not complete the restart." : null
  };
}

test("restart progress distinguishes disconnect, verification, and exact completion", () => {
  assert.equal(resolveManorRestartProgressPhase({ progress: progress("running"), connected: false, hasConnected: true, hadDisconnect: true, statusReachable: false }), "reconnecting");
  assert.equal(resolveManorRestartProgressPhase({ progress: progress("running"), connected: true, hasConnected: true, hadDisconnect: true, statusReachable: true }), "verifying");
  assert.equal(resolveManorRestartProgressPhase({ progress: progress("completed"), connected: true, hasConnected: true, hadDisconnect: true, statusReachable: true }), "confirmed");
  assert.equal(resolveManorRestartProgressPhase({ progress: progress("completed"), connected: false, hasConnected: true, hadDisconnect: true, statusReachable: true }), "reconnecting");
});

test("restart progress renders a persistent confirmation with a continue action", () => {
  const markup = renderToStaticMarkup(React.createElement(ManorRestartProgressDialog, {
    progress: progress("completed"),
    connected: true,
    hasConnected: true,
    hadDisconnect: true,
    statusReachable: true,
    acknowledging: false,
    actionError: null,
    onRetry() {},
    onAcknowledge() {}
  }));

  assert.match(markup, /Manor restarted/);
  assert.match(markup, /host controller confirmed completion/);
  assert.match(markup, />Continue</);
  assert.match(markup, /Restarting/);
  assert.match(markup, /Reconnecting/);
  assert.match(markup, /Confirmed/);
  assert.match(markup, /tabindex="-1"/);
});

test("restart progress never treats an unmatched controller run as success", () => {
  const markup = renderToStaticMarkup(React.createElement(ManorRestartProgressDialog, {
    progress: progress("unconfirmed"),
    connected: true,
    hasConnected: true,
    hadDisconnect: false,
    statusReachable: true,
    acknowledging: false,
    actionError: null,
    onRetry() {},
    onAcknowledge() {}
  }));

  assert.match(markup, /Restart status unconfirmed/);
  assert.match(markup, /Check again/);
  assert.doesNotMatch(markup, /Manor restarted/);
});
