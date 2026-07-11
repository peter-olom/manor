import { promises as fs } from "node:fs";
import path from "node:path";

import { readCodexAuthStatus } from "./auth-status.js";
import type { ButlerAuthStatus, ButlerOnboardingView, OnboardingCommandSet } from "./types.js";

type WorkerOnboardingRoute = {
  runtime?: "auto" | "openai" | "pi-rpc" | null;
  harness?: string | null;
  model?: string | null;
};

type WorkerOnboardingSettings = {
  overview: { workerProvider: string };
  worker: { defaultHarness: string | null; defaultModel: string | null };
  providers: {
    ollamaLocal: { providerId: string };
    ollamaCloud: { providerId: string };
    opencodeGo: { providerId: string };
  };
};

function modelRequiresCodexHarness(model: string | null | undefined, settings: WorkerOnboardingSettings): boolean | null {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  const slash = normalized.indexOf("/");
  if (slash <= 0) return true;
  const provider = normalized.slice(0, slash);
  const piProviders = new Set([
    "ollama-local",
    "ollama-cloud",
    "opencode-go",
    settings.providers.ollamaLocal.providerId.toLowerCase(),
    settings.providers.ollamaCloud.providerId.toLowerCase(),
    settings.providers.opencodeGo.providerId.toLowerCase()
  ]);
  if (piProviders.has(provider)) return false;
  if (provider === "openai" || provider === "openai-codex" || provider === "codex") return true;
  return null;
}

export function codexHarnessOnboardingRequired(workerDefaults: WorkerOnboardingRoute | null, settings: WorkerOnboardingSettings): boolean {
  if (workerDefaults?.harness === "codex" || workerDefaults?.runtime === "openai") return true;
  if (workerDefaults?.harness === "pi" || workerDefaults?.runtime === "pi-rpc") return false;
  const workerModelRequirement = modelRequiresCodexHarness(workerDefaults?.model, settings);
  if (workerModelRequirement !== null) return workerModelRequirement;
  if (settings.worker.defaultHarness === "codex") return true;
  if (settings.worker.defaultHarness === "pi") return false;
  const defaultModelRequirement = modelRequiresCodexHarness(settings.worker.defaultModel, settings);
  return defaultModelRequirement ?? settings.overview.workerProvider === "openai-codex";
}

function authModeLabel(auth: ButlerAuthStatus): string {
  if (auth.mode === "api") {
    return "API key";
  }

  if (auth.mode === "chatgpt") {
    return "ChatGPT";
  }

  return "Not connected";
}

function pendingAuthDetail(auth: ButlerAuthStatus, fallback: string): string {
  if (auth.validationError && auth.mode !== "none") {
    return `Stored ${authModeLabel(auth)} credentials are invalid. ${auth.validationError}`;
  }

  return fallback;
}

async function readGithubAuthStatus(codexConfigDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(codexConfigDir, "gh", "hosts.yml"), "utf8");
    return /^\s*oauth_token:\s*.+$/m.test(raw);
  } catch {
    return false;
  }
}

export async function buildOnboardingView(options: {
  butlerAuth: ButlerAuthStatus;
  codexAuth: ButlerAuthStatus;
  codexConfigDir: string;
  codexHarnessRequired: boolean;
}): Promise<ButlerOnboardingView> {
  const githubLoggedIn = await readGithubAuthStatus(options.codexConfigDir);

  const steps: ButlerOnboardingView["steps"] = [
    {
      id: "butlerAuth",
      title: "Sign in to Butler",
      status: options.butlerAuth.loggedIn ? "complete" : "pending",
      detail: options.butlerAuth.loggedIn
        ? `Connected through ${authModeLabel(options.butlerAuth)}.`
        : pendingAuthDetail(options.butlerAuth, "Connect Butler before using Butler chat."),
      commandSets: [
        {
          target: "localShell",
          detail: options.butlerAuth.loggedIn
            ? "Check Butler auth from your local shell."
            : "Run this from your local shell. Butler auth does not run inside the Codex terminal.",
          commands: options.butlerAuth.loggedIn
            ? ["docker exec manor-butler butler-auth status"]
            : ["docker exec -it manor-butler butler-auth device", "docker exec manor-butler butler-auth api-key"]
        },
        {
          target: "butlerTerminal",
          detail: options.butlerAuth.loggedIn
            ? "Check Butler auth from the Butler terminal."
            : "Run this in the Butler terminal to connect Butler.",
          commands: options.butlerAuth.loggedIn ? ["butler-auth status"] : ["butler-auth device", "butler-auth api-key"]
        }
      ]
    }
  ];

  if (options.codexHarnessRequired) {
    steps.push({
      id: "codexAuth",
      title: "Sign in to Codex",
      status: options.codexAuth.loggedIn ? "complete" : "pending",
      detail: options.codexAuth.loggedIn
        ? `Connected through ${authModeLabel(options.codexAuth)}.`
        : pendingAuthDetail(options.codexAuth, "Connect the Codex harness before opening Worker jobs through it."),
      commandSets: buildCodexCommandSets({
        localShellCommands: options.codexAuth.loggedIn
          ? ["docker exec manor-codex-box codex-auth status"]
          : ["docker exec -it manor-codex-box codex-auth device", "docker exec manor-codex-box codex-auth api-key"],
        terminalTarget: "codexTerminal",
        terminalCommands: options.codexAuth.loggedIn ? ["codex-auth status"] : ["codex-auth device", "codex-auth api-key"],
        connectedDetail: options.codexAuth.loggedIn ? "Check Codex auth from the built-in Terminal or your local shell." : undefined,
        pendingTerminalDetail: "Run this in the built-in Terminal before opening Worker jobs through the Codex harness."
      })
    },
    {
      id: "githubAuth",
      title: "Sign in to GitHub in Codex",
      status: githubLoggedIn ? "complete" : "pending",
      detail: githubLoggedIn
        ? "Connected. Workers using the Codex harness can use GitHub from the container."
        : "Connect GitHub in the Codex harness before asking a Worker through it to clone or push repositories.",
      commandSets: buildCodexCommandSets({
        localShellCommands: githubLoggedIn
          ? ["docker exec manor-codex-box gh auth status"]
          : [
              "docker exec -it manor-codex-box gh-auth-headless",
              "docker exec manor-codex-box gh auth status"
            ],
        terminalTarget: "codexTerminal",
        terminalCommands: githubLoggedIn ? ["gh auth status"] : ["gh-auth-headless", "gh auth status"],
        connectedDetail: githubLoggedIn ? "Check GitHub auth from the built-in Terminal or your local shell." : undefined,
        pendingTerminalDetail: "Run this in the built-in Terminal to start headless GitHub sign-in in Codex."
      })
    });
  }

  return {
    complete: steps.every((step) => step.status === "complete"),
    steps
  };
}

function buildCodexCommandSets(options: {
  localShellCommands: string[];
  terminalTarget: "butlerTerminal" | "codexTerminal";
  terminalCommands: string[];
  connectedDetail?: string;
  pendingTerminalDetail: string;
}): OnboardingCommandSet[] {
  return [
    {
      target: "localShell",
      detail: options.connectedDetail ?? "Run this from your local shell.",
      commands: options.localShellCommands
    },
    {
      target: options.terminalTarget,
      detail: options.connectedDetail ?? options.pendingTerminalDetail,
      commands: options.terminalCommands
    }
  ];
}
