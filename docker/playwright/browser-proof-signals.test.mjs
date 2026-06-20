import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRemediationHints,
  classifyFailure,
  detectCloudflareChallengeSignals,
  detectHtmlErrorSignals
} from "./browser-proof-signals.mjs";

const challengeHtml = `
  <html>
    <head><title>Just a moment...</title></head>
    <body>
      <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
      <div class="cf-turnstile">Verify you are human</div>
      <p>Cloudflare Ray ID: abc123</p>
    </body>
  </html>
`;

test("detects Cloudflare managed challenge pages in browser proof HTML", () => {
  assert.equal(detectCloudflareChallengeSignals("Just a moment...", challengeHtml), true);
  assert.deepEqual(detectHtmlErrorSignals("Just a moment...", challengeHtml), ["Cloudflare managed challenge"]);
});

test("classifies Cloudflare challenge proof as egress before auth/http", () => {
  const failureKind = classifyFailure({
    ok: false,
    error: null,
    status: 403,
    failedPhase: null,
    selectorExpected: false,
    selectorSatisfied: null,
    sameOriginAssetFailureCount: 0,
    htmlErrorSignals: ["Cloudflare managed challenge"],
    loginRedirectDetected: false,
    captureMissing: false,
    noVisualContent: false
  });

  assert.equal(failureKind, "egress");
});

test("classifies action/navigation timeouts with Cloudflare final HTML as egress", () => {
  const failureKind = classifyFailure({
    ok: false,
    error: "Timeout while running browser action.",
    status: 403,
    failedPhase: "action",
    selectorExpected: false,
    selectorSatisfied: null,
    sameOriginAssetFailureCount: 0,
    htmlErrorSignals: ["Cloudflare managed challenge"],
    loginRedirectDetected: false,
    captureMissing: false,
    noVisualContent: false
  });

  const hints = buildRemediationHints({
    preflightStages: null,
    failureKind,
    status: 403,
    selectorExpected: null,
    selectorSatisfied: null,
    htmlErrorSignals: ["Cloudflare managed challenge"],
    noVisualContent: false,
    consoleMessages: []
  });

  assert.equal(failureKind, "egress");
  assert.equal(hints.length, 1);
  assert.match(hints[0], /allowlisted egress profile\/domain/);
  assert.match(hints[0], /supported Manor stack\/preview route/);
});


test("egress failures include operator-controlled remediation guidance", () => {
  const hints = buildRemediationHints({
    preflightStages: null,
    failureKind: "egress",
    status: 403,
    selectorExpected: null,
    selectorSatisfied: null,
    htmlErrorSignals: ["Cloudflare managed challenge"],
    noVisualContent: false,
    consoleMessages: []
  });

  assert.equal(hints.length, 1);
  assert.match(hints[0], /allowlisted egress profile\/domain/);
  assert.match(hints[0], /supported Manor stack\/preview route/);
});
