import { promises as fs } from "node:fs";
import path from "node:path";

import type { ButlerAuthStatus, ButlerOnboardingView, OnboardingCommandSet } from "./types.js";

type WorkerOnboardingRoute = {
  model?: string | null;
};

type WorkerOnboardingSettings = {
  overview: { workerProvider: string };
  worker: { defaultModel: string | null };
  providers: {
    ollamaLocal: { providerId: string };
    ollamaCloud: { providerId: string };
    opencodeGo: { providerId: string };
  };
};

function modelRequiresOpenAiAuth(model: string | null | undefined, settings: WorkerOnboardingSettings): boolean | null {
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
  if (provider === "openai" || provider === "openai-codex") return true;
  return null;
}

export function workerOpenAiOnboardingRequired(workerDefaults: WorkerOnboardingRoute | null, settings: WorkerOnboardingSettings): boolean {
  const workerModelRequirement = modelRequiresOpenAiAuth(workerDefaults?.model, settings);
  if (workerModelRequirement !== null) return workerModelRequirement;
  const defaultModelRequirement = modelRequiresOpenAiAuth(settings.worker.defaultModel, settings);
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

async function readGithubAuthStatus(workerConfigDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(workerConfigDir, "gh", "hosts.yml"), "utf8");
    return /^\s*oauth_token:\s*.+$/m.test(raw);
  } catch {
    return false;
  }
}

export async function buildOnboardingView(options: {
  butlerAuth: ButlerAuthStatus;
  workerAuth: ButlerAuthStatus;
  workerConfigDir: string;
  workerOpenAiRequired: boolean;
}): Promise<ButlerOnboardingView> {
  const githubLoggedIn = await readGithubAuthStatus(options.workerConfigDir);

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
            : "Run this from your local shell. Butler auth is separate from Worker auth.",
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

  if (options.workerOpenAiRequired) {
    steps.push({
      id: "workerAuth",
      title: "Connect OpenAI for Worker",
      status: options.workerAuth.loggedIn ? "complete" : "pending",
      detail: options.workerAuth.loggedIn
        ? `Connected through ${authModeLabel(options.workerAuth)}.`
        : pendingAuthDetail(options.workerAuth, "Connect OpenAI in the Worker Pi environment before choosing an OpenAI Worker model."),
      commandSets: buildWorkerCommandSets({
        localShellCommands: options.workerAuth.loggedIn
          ? ["docker exec -e PI_AGENT_DIR=/worker-pi/agent manor-butler butler-auth status"]
          : ["docker exec -it -e PI_AGENT_DIR=/worker-pi/agent manor-butler butler-auth device", "docker exec -e PI_AGENT_DIR=/worker-pi/agent manor-butler butler-auth api-key"],
        terminalTarget: "butlerTerminal",
        terminalCommands: options.workerAuth.loggedIn ? ["PI_AGENT_DIR=/worker-pi/agent butler-auth status"] : ["PI_AGENT_DIR=/worker-pi/agent butler-auth device", "PI_AGENT_DIR=/worker-pi/agent butler-auth api-key"],
        connectedDetail: options.workerAuth.loggedIn ? "Worker OpenAI authentication is active." : undefined,
        pendingTerminalDetail: "Use Settings → Providers to connect OpenAI for Worker."
      })
    },
    {
      id: "githubAuth",
      title: "Sign in to GitHub for Worker",
      status: githubLoggedIn ? "complete" : "pending",
      detail: githubLoggedIn
        ? "Connected. Worker can use GitHub from its container."
        : "Connect GitHub before asking Worker to clone or push repositories.",
      commandSets: buildWorkerCommandSets({
        localShellCommands: githubLoggedIn
          ? ["docker exec manor-worker gh auth status"]
          : [
              "docker exec -it manor-worker gh-auth-headless",
              "docker exec manor-worker gh auth status"
            ],
        terminalTarget: "workerTerminal",
        terminalCommands: githubLoggedIn ? ["gh auth status"] : ["gh-auth-headless", "gh auth status"],
        connectedDetail: githubLoggedIn ? "Check GitHub auth from the built-in Terminal or your local shell." : undefined,
        pendingTerminalDetail: "Run this in the Worker terminal to start headless GitHub sign-in."
      })
    });
  }

  return {
    complete: steps.every((step) => step.status === "complete"),
    steps
  };
}

function buildWorkerCommandSets(options: {
  localShellCommands: string[];
  terminalTarget: "butlerTerminal" | "workerTerminal";
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
