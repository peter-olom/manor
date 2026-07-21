import { useState } from "react";

import { postJson } from "./api";
import { authActionLabel, authUsageHint, formatAuthSummary, type AuthStatusView, type AuthTarget } from "./openai-auth-settings";
import { OpenAiAuthPending } from "./OpenAiAuthPending";

export type AuthCheckResult = { ok: boolean; message: string; checkedAt: number };

export function useAuthChecks() {
  const [authCheckingTarget, setAuthCheckingTarget] = useState<AuthTarget | null>(null);
  const [authChecks, setAuthChecks] = useState<Record<AuthTarget, AuthCheckResult | null>>({ butler: null, worker: null });
  const clearAuthChecks = () => setAuthChecks({ butler: null, worker: null });
  const clearAuthCheck = (target: AuthTarget) => setAuthChecks((current) => ({ ...current, [target]: null }));
  const checkAuth = async (target: AuthTarget) => {
    setAuthCheckingTarget(target);
    setAuthChecks((current) => ({ ...current, [target]: null }));
    try {
      const result = await postJson<AuthCheckResult>(`/api/settings/auth/${target}/check`, {});
      setAuthChecks((current) => ({ ...current, [target]: result }));
    } catch (error) {
      setAuthChecks((current) => ({
        ...current,
        [target]: { ok: false, message: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }
      }));
    } finally {
      setAuthCheckingTarget(null);
    }
  };
  return { authCheckingTarget, authChecks, clearAuthCheck, clearAuthChecks, checkAuth };
}

function AuthField({ label, target, auth }: { label: string; target: AuthTarget; auth: AuthStatusView }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      <input readOnly value={formatAuthSummary(auth)} />
      <small>{authUsageHint(target, auth)}</small>
    </label>
  );
}

function AuthActions({
  target,
  auth,
  authPending,
  authTarget,
  authCheckingTarget,
  authCheck,
  onStartAuth,
  onCheckAuth
}: {
  target: AuthTarget;
  auth: AuthStatusView;
  authPending: boolean;
  authTarget: AuthTarget | null;
  authCheckingTarget: AuthTarget | null;
  authCheck: AuthCheckResult | null;
  onStartAuth: (target: AuthTarget) => Promise<void>;
  onCheckAuth: (target: AuthTarget) => Promise<void>;
}) {
  const checking = authCheckingTarget === target;
  const busy = authPending || authCheckingTarget !== null;
  return (
    <>
      <div className="settings-auth-actions">
        <button className={`button ${auth.loggedIn ? "" : "is-primary"}`} type="button" onClick={() => void onStartAuth(target)} disabled={busy}>
          {authPending && authTarget === target ? "Starting…" : authActionLabel(target, auth)}
        </button>
        <button className="button" type="button" aria-label={`Check ${target === "butler" ? "Butler" : "Worker"} auth`} onClick={() => void onCheckAuth(target)} disabled={busy}>
          {checking ? "Checking…" : "Check auth"}
        </button>
      </div>
      {authCheck ? <div className={`settings-auth-check is-${authCheck.ok ? "ok" : "failed"}`} role={authCheck.ok ? "status" : "alert"}>{authCheck.message}</div> : null}
    </>
  );
}

export function OpenAiAuthSettings({
  auth,
  authError,
  authUrl,
  authTarget,
  authPending,
  authCheckingTarget,
  authChecks,
  onStartAuth,
  onCompleteAuth,
  onRefreshAuth,
  onCheckAuth
}: {
  auth: { butler: AuthStatusView; worker: AuthStatusView };
  authError: string | null;
  authUrl: string | null;
  authTarget: AuthTarget | null;
  authPending: boolean;
  authCheckingTarget: AuthTarget | null;
  authChecks: Record<AuthTarget, AuthCheckResult | null>;
  onStartAuth: (target: AuthTarget) => Promise<void>;
  onCompleteAuth: (authorizationInput: string) => Promise<void>;
  onRefreshAuth: () => Promise<void>;
  onCheckAuth: (target: AuthTarget) => Promise<void>;
}) {
  return (
    <>
      {authError ? <div className="settings-auth-error" role="alert">{authError}</div> : null}
      {authUrl && authTarget ? <OpenAiAuthPending authUrl={authUrl} target={authTarget} onComplete={onCompleteAuth} onRefresh={onRefreshAuth} /> : null}
      <AuthField label="Butler" target="butler" auth={auth.butler} />
      <AuthActions target="butler" auth={auth.butler} authPending={authPending} authTarget={authTarget} authCheckingTarget={authCheckingTarget} authCheck={authChecks.butler} onStartAuth={onStartAuth} onCheckAuth={onCheckAuth} />
      <AuthField label="Worker" target="worker" auth={auth.worker} />
      <AuthActions target="worker" auth={auth.worker} authPending={authPending} authTarget={authTarget} authCheckingTarget={authCheckingTarget} authCheck={authChecks.worker} onStartAuth={onStartAuth} onCheckAuth={onCheckAuth} />
      <label className="settings-field">
        <span className="settings-field-label">Web tools</span>
        <input readOnly value="Built into ChatGPT" />
        <small>Web search/fetch is built into ChatGPT — no separate config needed.</small>
      </label>
    </>
  );
}
