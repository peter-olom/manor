import { useState } from "react";

import type { AuthTarget } from "./openai-auth-settings";

export function OpenAiAuthPending({
  authUrl,
  target,
  onComplete,
  onRefresh
}: {
  authUrl: string;
  target: AuthTarget;
  onComplete: (authorizationInput: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [authorizationInput, setAuthorizationInput] = useState("");
  const [completing, setCompleting] = useState(false);

  async function complete() {
    if (!authorizationInput.trim()) return;
    setCompleting(true);
    try {
      await onComplete(authorizationInput.trim());
    } finally {
      setCompleting(false);
    }
  }

  return (
    <div className="settings-auth-pending">
      <span>Waiting for {target === "worker" ? "Worker" : "Butler"} ChatGPT sign-in to complete…</span>
      <a href={authUrl} target="_blank" rel="noopener noreferrer">Open auth page again</a>
      <span>If the browser ends at localhost, copy the full URL and paste it below.</span>
      <div className="settings-auth-completion">
        <input
          aria-label="Final ChatGPT callback URL"
          autoComplete="off"
          placeholder="Paste final localhost callback URL"
          type="password"
          value={authorizationInput}
          onChange={(event) => setAuthorizationInput(event.target.value)}
        />
        <button className="button is-primary" type="button" disabled={completing || !authorizationInput.trim()} onClick={() => void complete()}>
          {completing ? "Completing…" : "Complete sign-in"}
        </button>
      </div>
      <button className="button" type="button" onClick={() => void onRefresh()}>I've signed in — refresh</button>
    </div>
  );
}
