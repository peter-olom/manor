import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type express from "express";

import { readButlerAuthStatus } from "./auth-status.js";

type AuthLoginSession = {
  child: ChildProcessWithoutNullStreams;
  authUrl: string | null;
  startedAt: number;
  output: string;
  completion: Promise<AuthLoginCompletion>;
  finishCompletion: (result: AuthLoginCompletion) => void;
  manualInputSubmitted: boolean;
};

type AuthLoginCompletion =
  | { ok: true }
  | { ok: false; error: string };

type AuthTarget = "butler" | "worker";

type AuthProcessIdentity = {
  uid?: number;
  gid?: number;
};

const defaultAuthLoginTimeoutMs = 15_000;
const authCompletionTimeoutMs = 120_000;
const maxAuthorizationInputLength = 8_192;

class AuthLoginConflictError extends Error {}

function extractPiAuthUrl(output: string): string | null {
  const match = output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/);
  return match ? match[0] : null;
}

/**
 * Run the login process as the owner of the target Pi agent directory when the
 * Butler server is privileged. This keeps the Worker-owned auth file writable
 * by the Worker after Pi rotates its OAuth refresh token.
 */
export async function authProcessIdentityForPiAgentDir(piAgentDir: string): Promise<AuthProcessIdentity> {
  await mkdir(piAgentDir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return {};
  const owner = await stat(piAgentDir);
  return { uid: owner.uid, gid: owner.gid };
}

function clearAuthLoginSession(current: AuthLoginSession | null, child: ChildProcessWithoutNullStreams): AuthLoginSession | null {
  return current?.child === child ? null : current;
}

export function registerDeviceAuthRoutes(
  app: express.Express,
  options: {
    butlerPiAgentDir: string;
    workerPiAgentDir: string;
    authCommand?: string;
    authCommandArgs?: string[];
    authLoginTimeoutMs?: number;
    authCompletionTimeoutMs?: number;
    onAuthChanged?: (target: AuthTarget) => void | Promise<void>;
  }
): void {
  let butlerAuthLoginSession: AuthLoginSession | null = null;
  let workerAuthLoginSession: AuthLoginSession | null = null;

  function sessionFor(target: AuthTarget): AuthLoginSession | null {
    return target === "butler" ? butlerAuthLoginSession : workerAuthLoginSession;
  }

  function setSession(target: AuthTarget, session: AuthLoginSession | null): void {
    if (target === "butler") butlerAuthLoginSession = session;
    else workerAuthLoginSession = session;
  }

  async function startPiAuthLogin(target: AuthTarget, piAgentDir: string): Promise<string> {
    const otherTarget: AuthTarget = target === "butler" ? "worker" : "butler";
    if (sessionFor(otherTarget)) {
      throw new AuthLoginConflictError(`Finish or cancel the active ${otherTarget === "butler" ? "Butler" : "Worker"} sign-in before starting another sign-in.`);
    }
    const existing = sessionFor(target);
    if (existing?.authUrl) return existing.authUrl;
    if (existing) {
      existing.child.kill();
      setSession(target, null);
    }

    const identity = await authProcessIdentityForPiAgentDir(piAgentDir);
    const child = spawn(options.authCommand ?? "butler-auth", [...(options.authCommandArgs ?? []), "device"], {
      ...identity,
      env: {
        ...process.env,
        PI_AGENT_DIR: piAgentDir,
        PI_CODING_AGENT_DIR: piAgentDir
      }
    });

    let finishCompletion = (_result: AuthLoginCompletion): void => {};
    const completion = new Promise<AuthLoginCompletion>((resolve) => {
      let finished = false;
      finishCompletion = (result) => {
        if (finished) return;
        finished = true;
        resolve(result);
      };
    });

    const authSession: AuthLoginSession = {
      child,
      authUrl: null,
      startedAt: Date.now(),
      output: "",
      completion,
      finishCompletion,
      manualInputSubmitted: false
    };
    setSession(target, authSession);

    return new Promise((resolve, reject) => {
      const label = target === "butler" ? "Butler" : "Worker";
      const timeout = setTimeout(() => {
        child.kill();
        setSession(target, clearAuthLoginSession(sessionFor(target), child));
        reject(new Error(`Timed out waiting for ${label} auth URL. Open the ${label} terminal and run butler-auth device.`));
      }, options.authLoginTimeoutMs ?? defaultAuthLoginTimeoutMs);

      const finishWithUrl = (chunk: Buffer) => {
        const session = sessionFor(target);
        if (!session || session.child !== child) return;
        session.output += chunk.toString("utf8");
        const authUrl = extractPiAuthUrl(session.output);
        if (!authUrl) return;
        session.authUrl = authUrl;
        clearTimeout(timeout);
        resolve(authUrl);
      };

      child.stdout.on("data", finishWithUrl);
      child.stderr.on("data", finishWithUrl);
      child.on("error", (error) => {
        clearTimeout(timeout);
        setSession(target, clearAuthLoginSession(sessionFor(target), child));
        authSession.finishCompletion({ ok: false, error: error.message });
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        setSession(target, clearAuthLoginSession(sessionFor(target), child));
        if (code === 0) {
          authSession.finishCompletion({ ok: true });
          void Promise.resolve(options.onAuthChanged?.(target)).catch((error) => {
            console.error(`${label} auth refresh failed`, error);
          });
          return;
        }
        const error = new Error(`${label} auth exited with code ${code ?? "unknown"}. Start the sign-in again and use the latest callback URL.`);
        authSession.finishCompletion({ ok: false, error: error.message });
        reject(error);
      });
    });
  }

  function registerTarget(target: AuthTarget, piAgentDir: string): void {
    app.get(`/api/auth/${target}/status`, async (_request, response) => {
      response.json(await readButlerAuthStatus(path.join(piAgentDir, "auth.json")));
    });

    app.post(`/api/auth/${target}/device`, async (_request, response) => {
      try {
        const authUrl = await startPiAuthLogin(target, piAgentDir);
        response.json({
          authUrl,
          startedAt: sessionFor(target)?.startedAt ?? Date.now()
        });
      } catch (error) {
        response.status(error instanceof AuthLoginConflictError ? 409 : 500).json({
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    app.post(`/api/auth/${target}/device/complete`, async (request, response) => {
      const authorizationInput = typeof request.body?.authorizationInput === "string"
        ? request.body.authorizationInput.trim()
        : "";
      if (!authorizationInput || authorizationInput.length > maxAuthorizationInputLength) {
        response.status(400).json({ error: "Paste the final localhost callback URL or authorization code from the current sign-in." });
        return;
      }

      const session = sessionFor(target);
      if (!session || !session.authUrl || !session.child.stdin.writable) {
        response.status(409).json({ error: "No active sign-in is waiting for a callback. Start the sign-in again." });
        return;
      }
      if (session.manualInputSubmitted) {
        response.status(409).json({ error: "This sign-in callback has already been submitted." });
        return;
      }

      session.manualInputSubmitted = true;
      const writeError = await new Promise<Error | null>((resolve) => {
        try {
          session.child.stdin.write(`${authorizationInput}\n`, (error) => resolve(error ?? null));
        } catch (error) {
          resolve(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (writeError) {
        session.child.kill();
        setSession(target, clearAuthLoginSession(sessionFor(target), session.child));
        response.status(500).json({ error: `The sign-in process closed before it received the callback: ${writeError.message}` });
        return;
      }
      let completionTimeout: ReturnType<typeof setTimeout> | null = null;
      const completionTimeoutMessage = "Timed out completing sign-in. Start again and use the latest callback URL.";
      const completion = await Promise.race<AuthLoginCompletion>([
        session.completion,
        new Promise((resolve) => {
          completionTimeout = setTimeout(() => resolve({ ok: false, error: completionTimeoutMessage }), options.authCompletionTimeoutMs ?? authCompletionTimeoutMs);
        })
      ]);
      if (completionTimeout) clearTimeout(completionTimeout);
      if (!completion.ok) {
        if (completion.error === completionTimeoutMessage) {
          session.child.kill();
          setSession(target, clearAuthLoginSession(sessionFor(target), session.child));
        }
        response.status(500).json({ error: completion.error });
        return;
      }
      response.json({ ok: true });
    });
  }

  registerTarget("butler", options.butlerPiAgentDir);
  registerTarget("worker", options.workerPiAgentDir);
}
