export type AuthTarget = "butler" | "worker";

export type AuthStatusView = {
  mode: "chatgpt" | "api" | "none" | "unknown";
  loggedIn: boolean;
  validationError: string | null;
  lastValidatedAt: number | null;
};

export function formatAuthSummary(auth?: AuthStatusView): string {
  if (!auth) return "Unknown";
  if (!auth.loggedIn) return auth.validationError ? `Not signed in — ${auth.validationError}` : "Not signed in";
  if (auth.mode === "chatgpt") return "Signed in with ChatGPT";
  if (auth.mode === "api") return "Signed in with API key";
  return "Signed in";
}

export function authUsageHint(target: AuthTarget, auth: AuthStatusView): string {
  if (!auth.loggedIn) {
    return target === "butler"
      ? "Connect ChatGPT for Butler chat."
      : "Connect ChatGPT for Worker tasks.";
  }

  const confirmation = target === "butler" ? "Send Butler a message" : "Start a Worker task";
  if (auth.mode === "chatgpt") {
    return `Pi refreshes this sign-in automatically when needed. ${confirmation} to confirm it works.`;
  }
  return `${confirmation} to confirm this authentication works.`;
}

export function authActionLabel(target: AuthTarget, auth: AuthStatusView): string {
  if (auth.loggedIn) return auth.mode === "chatgpt" ? "Sign in again" : "Switch to ChatGPT";
  return target === "butler" ? "Connect Butler" : "Connect Worker";
}
