import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OpenAiAuthSettings } from "../../src/web/OpenAiAuthSettings.js";
import type { AuthStatusView } from "../../src/web/openai-auth-settings.js";

function auth(loggedIn: boolean): AuthStatusView {
  return { mode: loggedIn ? "chatgpt" : "none", loggedIn, validationError: null, lastValidatedAt: null };
}

function render(butlerLoggedIn: boolean, workerLoggedIn: boolean): string {
  return renderToStaticMarkup(React.createElement(OpenAiAuthSettings, {
    auth: { butler: auth(butlerLoggedIn), worker: auth(workerLoggedIn) },
    authError: null,
    authUrl: null,
    authTarget: null,
    authPending: false,
    authCheckingTarget: null,
    authChecks: { butler: null, worker: null },
    onStartAuth: async () => undefined,
    onCompleteAuth: async () => undefined,
    onRefreshAuth: async () => undefined,
    onCheckAuth: async () => undefined
  }));
}

test("OpenAI settings offer auth checks only for signed-in agents", () => {
  const workerSignedOut = render(true, false);
  assert.match(workerSignedOut, /Check Butler auth/);
  assert.doesNotMatch(workerSignedOut, /Check Worker auth/);
  assert.match(workerSignedOut, /Connect Worker/);

  const butlerSignedOut = render(false, true);
  assert.doesNotMatch(butlerSignedOut, /Check Butler auth/);
  assert.match(butlerSignedOut, /Check Worker auth/);
  assert.match(butlerSignedOut, /Connect Butler/);
});
