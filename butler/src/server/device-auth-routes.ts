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
};

type AuthTarget = "butler" | "worker";

type AuthProcessIdentity = {
  uid?: number;
  gid?: number;
};

const defaultAuthLoginTimeoutMs = 15_000;

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

    const authSession: AuthLoginSession = {
      child,
      authUrl: null,
      startedAt: Date.now(),
      output: ""
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
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        setSession(target, clearAuthLoginSession(sessionFor(target), child));
        if (code === 0) {
          void Promise.resolve(options.onAuthChanged?.(target)).catch((error) => {
            console.error(`${label} auth refresh failed`, error);
          });
          return;
        }
        reject(new Error(`${label} auth exited with code ${code ?? "unknown"}. Open the ${label} terminal and run butler-auth device.`));
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
  }

  registerTarget("butler", options.butlerPiAgentDir);
  registerTarget("worker", options.workerPiAgentDir);
}
