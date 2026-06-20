export function detectCloudflareChallengeSignals(title, bodyText) {
  const normalized = `${title}\n${bodyText}`.toLowerCase();
  const candidates = [
    /just a moment/i,
    /verify you are human/i,
    /checking your browser/i,
    /cloudflare ray id/i,
    /cf-turnstile/i,
    /managed challenge/i,
    /cdn-cgi\/challenge-platform/i,
    /cf_chl_/i,
    /challenge-platform\/h\/[bg]\/orchestrate/i
  ];
  return candidates.some((pattern) => pattern.test(normalized));
}

export function detectHtmlErrorSignals(title, bodyText) {
  const signals = [];
  const normalized = `${title}\n${bodyText}`.toLowerCase();
  if (detectCloudflareChallengeSignals(title, bodyText)) {
    signals.push("Cloudflare managed challenge");
  }
  const candidates = [
    { pattern: /502 bad gateway/, label: "502 Bad Gateway" },
    { pattern: /504 gateway timeout/, label: "504 Gateway Timeout" },
    { pattern: /500 internal server error/, label: "500 Internal Server Error" },
    { pattern: /application error/, label: "Application error" },
    { pattern: /something went wrong/, label: "Something went wrong" },
    { pattern: /\b404\b.{0,40}\bnot found\b|\bnot found\b.{0,40}\b404\b/i, label: "404 Not Found" },
    { pattern: /directory listing for \//, label: "Directory listing" },
    { pattern: /index of \//, label: "Directory listing" },
    { pattern: /blocked request\. this host /, label: "Host allowlist blocked" }
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(normalized)) {
      signals.push(candidate.label);
    }
  }

  return [...new Set(signals)].slice(0, 8);
}

export function classifyFailure(input) {
  if (input.ok) {
    return "none";
  }

  if (input.htmlErrorSignals.includes("Cloudflare managed challenge")) {
    return "egress";
  }

  if (input.failedPhase === "action") {
    return "script";
  }

  if (input.status !== null && input.status >= 400) {
    if (input.status === 403 && input.htmlErrorSignals.includes("Host allowlist blocked")) {
      return "readiness";
    }
    if (input.status === 401 || input.status === 403 || input.loginRedirectDetected) {
      return "auth";
    }
    return "http";
  }

  if (input.loginRedirectDetected) {
    return "auth";
  }

  if (input.selectorExpected && input.selectorSatisfied === false) {
    return "readiness";
  }

  if (input.noVisualContent) {
    return "readiness";
  }

  if (input.sameOriginAssetFailureCount > 0 || input.htmlErrorSignals.length > 0) {
    return "readiness";
  }

  if (input.captureMissing) {
    return "artifact";
  }

  if (input.failedPhase === "await_ready") {
    return "readiness";
  }

  return input.error ? "unknown" : "preview";
}

export function buildRemediationHints(input) {
  const hints = [];
  if (input.preflightStages?.networkReachable?.ok === false && input.preflightStages.networkReachable.hint) {
    hints.push(input.preflightStages.networkReachable.hint);
  }
  if (input.failureKind === "egress") {
    hints.push("Browser proof reached a Cloudflare/Turnstile managed challenge from Manor egress; ask the operator for an allowlisted egress profile/domain or run the target stack through a supported Manor stack/preview route.");
  }
  if (input.failureKind === "auth") {
    hints.push("Provide valid session cookies or auth headers for protected routes.");
  }
  if (input.failureKind === "http" && input.status && input.status >= 500) {
    hints.push("Check preview logs for backend/runtime errors before retrying browser smoke.");
  }
  if (input.failureKind === "readiness" && input.selectorExpected && input.selectorSatisfied === false) {
    hints.push(`Wait for selector ${input.selectorExpected} or verify the selector is still correct.`);
  }
  if (input.failureKind === "readiness" && input.htmlErrorSignals.includes("Host allowlist blocked")) {
    hints.push("Run the dev server with host binding enabled (for example --host 0.0.0.0).");
  }
  if (input.failureKind === "readiness" && input.noVisualContent) {
    hints.push("Page loaded but no visible UI rendered; provide --wait-for with a stable selector or fix frontend runtime errors.");
  }
  if (
    input.failureKind === "readiness" &&
    Array.isArray(input.consoleMessages) &&
    input.consoleMessages.some((entry) =>
      /Failed to load module script|Unexpected token '<'|ReferenceError|TypeError|Cannot find module/i.test(
        String(entry?.text || "")
      )
    )
  ) {
    hints.push("Resolve client-side script/module errors surfaced in console output before rerunning proof.");
  }
  if (input.failureKind === "script") {
    hints.push("Review the failed browser action script and rerun the session.");
  }
  if (input.failureKind === "artifact") {
    hints.push("Retry with stable browser startup; required proof artifacts were missing.");
  }
  return [...new Set(hints)].filter(Boolean);
}
