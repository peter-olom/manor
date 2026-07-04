import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type express from "express";

type AuthLoginSession = {
  child: ChildProcessWithoutNullStreams;
  authUrl: string | null;
  startedAt: number;
  output: string;
};

const authLoginTimeoutMs = 15_000;

function extractButlerAuthUrl(output: string): string | null {
  const match = output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/);
  return match ? match[0] : null;
}

function extractCodexAuthUrl(output: string): string | null {
  const match = output.match(/https:\/\/auth\.openai\.com\/codex\/device\S*/);
  return match ? match[0] : null;
}

function clearAuthLoginSession(current: AuthLoginSession | null, child: ChildProcessWithoutNullStreams): AuthLoginSession | null {
  return current?.child === child ? null : current;
}

export function registerDeviceAuthRoutes(
  app: express.Express,
  options: {
    piAgentDir: string;
    codexHomeDir: string;
  }
): void {
  let butlerAuthLoginSession: AuthLoginSession | null = null;
  let codexAuthLoginSession: AuthLoginSession | null = null;

  function startButlerAuthLogin(): Promise<string> {
    if (butlerAuthLoginSession?.authUrl) {
      return Promise.resolve(butlerAuthLoginSession.authUrl);
    }

    if (butlerAuthLoginSession) {
      butlerAuthLoginSession.child.kill();
      butlerAuthLoginSession = null;
    }

    const child = spawn("butler-auth", ["device"], {
      env: {
        ...process.env,
        PI_AGENT_DIR: options.piAgentDir,
        CODEX_HOME: process.env.CODEX_HOME ?? path.join(path.dirname(options.piAgentDir), ".codex")
      }
    });

    butlerAuthLoginSession = {
      child,
      authUrl: null,
      startedAt: Date.now(),
      output: ""
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Butler auth URL. Open the Butler terminal and run butler-auth device."));
      }, authLoginTimeoutMs);

      const finishWithUrl = (chunk: Buffer) => {
        const session = butlerAuthLoginSession;
        if (!session || session.child !== child) {
          return;
        }

        session.output += chunk.toString("utf8");
        const authUrl = extractButlerAuthUrl(session.output);
        if (!authUrl) {
          return;
        }

        session.authUrl = authUrl;
        clearTimeout(timeout);
        resolve(authUrl);
      };

      child.stdout.on("data", finishWithUrl);
      child.stderr.on("data", finishWithUrl);
      child.on("error", (error) => {
        clearTimeout(timeout);
        butlerAuthLoginSession = clearAuthLoginSession(butlerAuthLoginSession, child);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        butlerAuthLoginSession = clearAuthLoginSession(butlerAuthLoginSession, child);
        if (code !== 0) {
          reject(new Error(`Butler auth exited with code ${code ?? "unknown"}. Open the Butler terminal and run butler-auth device.`));
        }
      });
    });
  }

  function startCodexAuthLogin(): Promise<string> {
    if (codexAuthLoginSession?.authUrl) {
      return Promise.resolve(codexAuthLoginSession.authUrl);
    }

    if (codexAuthLoginSession) {
      codexAuthLoginSession.child.kill();
      codexAuthLoginSession = null;
    }

    const child = spawn("codex", ["login", "--device-auth"], {
      env: {
        ...process.env,
        CODEX_HOME: options.codexHomeDir
      }
    });

    codexAuthLoginSession = {
      child,
      authUrl: null,
      startedAt: Date.now(),
      output: ""
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Codex auth URL. Open the Codex terminal and run codex-auth device."));
      }, authLoginTimeoutMs);

      const finishWithUrl = (chunk: Buffer) => {
        const session = codexAuthLoginSession;
        if (!session || session.child !== child) {
          return;
        }

        session.output += chunk.toString("utf8");
        const authUrl = extractCodexAuthUrl(session.output);
        if (!authUrl) {
          return;
        }

        session.authUrl = authUrl;
        clearTimeout(timeout);
        resolve(authUrl);
      };

      child.stdout.on("data", finishWithUrl);
      child.stderr.on("data", finishWithUrl);
      child.on("error", (error) => {
        clearTimeout(timeout);
        codexAuthLoginSession = clearAuthLoginSession(codexAuthLoginSession, child);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        codexAuthLoginSession = clearAuthLoginSession(codexAuthLoginSession, child);
        if (code !== 0) {
          reject(new Error(`Codex auth exited with code ${code ?? "unknown"}. Open the Codex terminal and run codex-auth device.`));
        }
      });
    });
  }

  app.post("/api/auth/butler/device", async (_request, response) => {
    try {
      const authUrl = await startButlerAuthLogin();
      response.json({
        authUrl,
        startedAt: butlerAuthLoginSession?.startedAt ?? Date.now()
      });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/auth/codex/device", async (_request, response) => {
    try {
      const authUrl = await startCodexAuthLogin();
      response.json({
        authUrl,
        startedAt: codexAuthLoginSession?.startedAt ?? Date.now()
      });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
