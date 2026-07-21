import { authActionLabel, authUsageHint, formatAuthSummary, type AuthStatusView, type AuthTarget } from "./openai-auth-settings";
import { OpenAiAuthPending } from "./OpenAiAuthPending";

export type ButlerAuthCheckResult = { ok: boolean; message: string; checkedAt: number };

function AuthField({ label, target, auth }: { label: string; target: AuthTarget; auth: AuthStatusView }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <input readOnly value={formatAuthSummary(auth)} />
      <small>{authUsageHint(target, auth)}</small>
    </label>
  );
}

export function OpenAiAuthSettings({
  auth,
  authError,
  authUrl,
  authTarget,
  authPending,
  butlerAuthChecking,
  butlerAuthCheck,
  onStartAuth,
  onCompleteAuth,
  onRefreshAuth,
  onCheckButlerAuth
}: {
  auth: { butler: AuthStatusView; worker: AuthStatusView };
  authError: string | null;
  authUrl: string | null;
  authTarget: AuthTarget | null;
  authPending: boolean;
  butlerAuthChecking: boolean;
  butlerAuthCheck: ButlerAuthCheckResult | null;
  onStartAuth: (target: AuthTarget) => Promise<void>;
  onCompleteAuth: (authorizationInput: string) => Promise<void>;
  onRefreshAuth: () => Promise<void>;
  onCheckButlerAuth: () => Promise<void>;
}) {
  return (
    <>
      {authError ? <div className="settings-auth-error" role="alert">{authError}</div> : null}
      {authUrl && authTarget ? <OpenAiAuthPending authUrl={authUrl} target={authTarget} onComplete={onCompleteAuth} onRefresh={onRefreshAuth} /> : null}
      <AuthField label="Butler" target="butler" auth={auth.butler} />
      <div className="settings-auth-actions">
        <button className={`button ${auth.butler.loggedIn ? "" : "is-primary"}`} type="button" onClick={() => void onStartAuth("butler")} disabled={authPending || butlerAuthChecking}>
          {authPending && authTarget === "butler" ? "Starting…" : authActionLabel("butler", auth.butler)}
        </button>
        <button className="button" type="button" onClick={() => void onCheckButlerAuth()} disabled={authPending || butlerAuthChecking}>
          {butlerAuthChecking ? "Checking…" : "Check auth"}
        </button>
      </div>
      {butlerAuthCheck ? <div className={`settings-auth-check is-${butlerAuthCheck.ok ? "ok" : "failed"}`} role={butlerAuthCheck.ok ? "status" : "alert"}>{butlerAuthCheck.message}</div> : null}
      <AuthField label="Worker" target="worker" auth={auth.worker} />
      <div className="settings-auth-actions">
        <button className={`button ${auth.worker.loggedIn ? "" : "is-primary"}`} type="button" onClick={() => void onStartAuth("worker")} disabled={authPending || butlerAuthChecking}>
          {authPending && authTarget === "worker" ? "Starting…" : authActionLabel("worker", auth.worker)}
        </button>
      </div>
      <label className="settings-field">
        <span className="settings-field-label">Web tools</span>
        <input readOnly value="Built into ChatGPT" />
        <small>Web search/fetch is built into ChatGPT — no separate config needed.</small>
      </label>
    </>
  );
}
