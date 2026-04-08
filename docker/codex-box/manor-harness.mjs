#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const codeXHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const registryPath = path.join(codeXHome, "manor", "harness-capabilities.json");
const butlerBaseUrl = process.env.MANOR_BUTLER_BASE_URL || "http://butler:8080";
const runtimeBrokerBaseUrl = process.env.MANOR_RUNTIME_BROKER_URL || "http://runtime-broker:8090";

function printHelp() {
  console.log(`Usage:
  manor-harness [--thread <jobId>] status
  manor-harness [--thread <jobId>] report --status completed|blocked --summary "<text>" [--details "<text>"] [--turn-id <id>]
  manor-harness [--thread <jobId>] assist --summary "<text>" [--details "<text>"] [--question "<text>"]
  manor-harness [--thread <jobId>] stack list
  manor-harness [--thread <jobId>] stack start [--title <title>] [--cwd <path>] [--stateful] [--storage-mode ephemeral|job|base|custom] [--retain-volumes] [--storage-key <key>] [--clone-from <key>]
  manor-harness [--thread <jobId>] stack inspect <stackSelector>
  manor-harness [--thread <jobId>] stack promote <stackSelector> [--to <storageKey>]
  manor-harness [--thread <jobId>] stack stop <stackSelector> [--drop-volumes]
  manor-harness [--thread <jobId>] preview list
  manor-harness [--thread <jobId>] preview start --command "<cmd>" --port <port> [--title <title>] [--cwd <path>] [--stack <stackSelector>] [--alias <name> ...] [--env KEY=VALUE ...] [--image <image>] [--egress-profile <name>] [--egress-domain <domain> ...] [--bootstrap-wait-seconds <n>] [--bootstrap-hint <text>] [--heartbeat-kind none|http|tcp|command] [--heartbeat-target <value>] [--heartbeat-interval-seconds <n>]

Preview defaults:
  egress-profile=internet
  heartbeat-kind=http
  heartbeat-target=/
  preview commands start in the job worktree; prefer relative paths there or the contract cwd under /repos
  manor-harness preview inspect <previewSelector>
  manor-harness preview proof <previewSelector> [--run-id <id>]
  manor-harness preview processes <previewSelector>
  manor-harness preview logs <previewSelector> [--tail <n>]
  manor-harness preview exec <previewSelector> -- <command>
  manor-harness preview verify <previewSelector> [--mode headless|headful] [--path <route>] [--header KEY=VALUE ...] [--cookie NAME=VALUE ...] [--session-cookie <token>] [--wait-for <selector>] [--wait-ms <n>] [--script "<js>"] [--script-file <path>]
  manor-harness preview stop <previewSelector>
  manor-harness service templates
  manor-harness service list
  manor-harness service start --template <id> [--title <title>] [--cwd <path>] [--stack <stackSelector>] [--alias <name> ...] [--env KEY=VALUE ...]
  manor-harness service inspect <serviceSelector>
  manor-harness service processes <serviceSelector>
  manor-harness service logs <serviceSelector> [--tail <n>]
  manor-harness service exec <serviceSelector> -- <command>
  manor-harness service stop <serviceSelector>

Proof tips:
  Use --cookie NAME=VALUE to add cookies without hand-building a Cookie header.
  Use --session-cookie <token> as shorthand for better-auth.session_token=<token>.
  Cookies are injected into the browser context directly; headers remain separate.
  Example:
    manor-harness preview verify <preview> --mode headful --path buyer/messages --session-cookie buyer-token --script-file .local/proof.js --json

Add --json to print the Butler response payload as JSON.
Set MANOR_THREAD_ID or pass --thread <jobId> to bind the harness explicitly when you are outside the job workspace.`);
}

async function loadCapabilities() {
  const raw = await fs.readFile(registryPath, "utf8").catch(() => "");
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.capabilities) ? parsed.capabilities : [];
}

function getCapabilityByThreadId(capabilities, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return null;
  }

  return (
    capabilities.find((entry) => {
      return entry && typeof entry.threadId === "string" && entry.threadId === normalizedThreadId;
    }) ?? null
  );
}

function matchCapability(capabilities, cwd, explicitThreadId) {
  const directThreadMatch = getCapabilityByThreadId(capabilities, explicitThreadId);
  if (directThreadMatch) {
    return directThreadMatch;
  }

  const normalizedCwd = path.resolve(cwd);
  const matches = capabilities.filter((entry) => {
    if (!entry || typeof entry.cwd !== "string" || typeof entry.token !== "string") {
      return false;
    }
    const capabilityCwd = path.resolve(entry.cwd);
    return normalizedCwd === capabilityCwd || normalizedCwd.startsWith(`${capabilityCwd}${path.sep}`);
  });

  if (matches.length > 0) {
    return matches.sort((left, right) => String(right.cwd).length - String(left.cwd).length)[0] ?? null;
  }

  const currentProjectId = resolveWorkspaceProjectId(normalizedCwd);
  if (!currentProjectId) {
    return null;
  }

  const projectMatches = capabilities.filter((entry) => {
    if (!entry || typeof entry.cwd !== "string" || typeof entry.token !== "string") {
      return false;
    }
    return resolveWorkspaceProjectId(entry.cwd) === currentProjectId;
  });

  return projectMatches.length === 1 ? projectMatches[0] : null;
}

function formatCapabilityReference(capability) {
  return `${capability.threadId} (${capability.cwd})`;
}

function buildCapabilityLookupError(capabilities, cwd, explicitThreadId) {
  const normalizedThreadId = typeof explicitThreadId === "string" ? explicitThreadId.trim() : "";
  if (normalizedThreadId) {
    return `No Manor harness capability was found for job ${normalizedThreadId}. Start the job through Butler first or refresh the binding.`;
  }

  if (capabilities.length === 1) {
    return `No Manor harness capability matches ${cwd}, even though one active job exists: ${formatCapabilityReference(capabilities[0])}. Retry from that workspace or bind the command with --thread ${capabilities[0].threadId}.`;
  }

  if (capabilities.length > 1) {
    const activeJobs = capabilities.map((capability) => formatCapabilityReference(capability)).join(", ");
    return `No Manor harness capability matches ${cwd}. Retry from the job workspace or pass --thread <jobId>. Active jobs: ${activeJobs}.`;
  }

  return "No Manor harness capability is available for this workspace. Open this job through Butler first.";
}

function resolveWorkspaceProjectId(cwd) {
  const normalized = path.resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("/repos/.manor-worktrees/")) {
    const relative = normalized.slice("/repos/.manor-worktrees/".length);
    return relative.split("/").filter(Boolean)[0] || "";
  }

  if (normalized.startsWith("/repos/")) {
    const relative = normalized.slice("/repos/".length);
    return relative.split("/").filter(Boolean)[0] || "";
  }

  return "";
}

async function callHarness(token, action, params = {}) {
  const response = await fetch(new URL("/api/codex-harness/action", butlerBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ token, action, params })
  });

  const payload = await response.json().catch(() => ({ error: "Harness request failed" }));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `Harness request failed with ${response.status}`);
  }

  return payload;
}

async function callBroker(token, pathname, init = {}) {
  const response = await fetch(new URL(pathname, runtimeBrokerBaseUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-manor-codex-token": token,
      ...(init.headers ?? {})
    }
  });

  const payload = await response.json().catch(() => ({ error: "Broker request failed" }));
  if (!response.ok) {
    throw new Error(payload?.error || `Broker request failed with ${response.status}`);
  }

  return payload;
}

function formatProcessRows(result) {
  return result.processes.length === 0
    ? "No processes were reported."
    : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
}

function formatExecResult(result) {
  return [
    `exitCode=${result.exitCode ?? "unknown"}`,
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n\n") || "Command completed with no output.";
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseRepeatedKeyValueFlags(args, name) {
  return readRepeatedFlag(args, name)
    .map((entry) => {
      const marker = entry.indexOf("=");
      return marker === -1 ? null : [entry.slice(0, marker), entry.slice(marker + 1)];
    })
    .filter(Boolean);
}

function mergeCookieHeader(headers, cookieEntries) {
  if (cookieEntries.length === 0) {
    return headers;
  }

  const mergedHeaders = { ...headers };
  const existingCookieHeader = Object.entries(mergedHeaders).find(([key]) => key.toLowerCase() === "cookie");
  const cookieValue = cookieEntries.map(([key, value]) => `${key}=${value}`).join("; ");

  if (existingCookieHeader) {
    const [headerName, existingValue] = existingCookieHeader;
    mergedHeaders[headerName] = existingValue ? `${existingValue}; ${cookieValue}` : cookieValue;
  } else {
    mergedHeaders.cookie = cookieValue;
  }

  return mergedHeaders;
}

function readTailArg(args) {
  const raw = readFlag(args, "--tail", "200");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 200;
}

function readPositiveIntFlag(args, name) {
  const raw = readFlag(args, name, "");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function readCommandAfterDoubleDash(args) {
  const marker = args.indexOf("--");
  if (marker === -1) {
    return "";
  }
  return args.slice(marker + 1).join(" ").trim();
}

function readCommandArgsAfterDoubleDash(args) {
  const marker = args.indexOf("--");
  if (marker === -1) {
    return [];
  }
  return args.slice(marker + 1).filter(Boolean);
}

async function readStdinIfPresent() {
  if (process.stdin.isTTY) {
    return { stdin: undefined, stdinProvided: false };
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return {
    stdin: Buffer.concat(chunks).toString("utf8"),
    stdinProvided: true
  };
}

async function readScriptValue(args) {
  const inlineScript = readFlag(args, "--script", "");
  if (inlineScript) {
    return inlineScript;
  }

  const scriptFile = readFlag(args, "--script-file", "");
  if (!scriptFile) {
    return undefined;
  }

  const resolvedPath = path.resolve(process.cwd(), scriptFile);
  const raw = await fs.readFile(resolvedPath, "utf8");
  const script = raw.trim();
  return script || undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const threadFlagIndex = args.indexOf("--thread");
  let explicitThreadId = process.env.MANOR_THREAD_ID || "";
  if (threadFlagIndex !== -1) {
    explicitThreadId = args[threadFlagIndex + 1] ?? "";
    args.splice(threadFlagIndex, 2);
  }
  const jsonModeIndex = args.indexOf("--json");
  const jsonMode = jsonModeIndex !== -1;
  if (jsonMode) {
    args.splice(jsonModeIndex, 1);
  }

  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const capabilities = await loadCapabilities();
  const capability =
    matchCapability(capabilities, process.cwd(), explicitThreadId) ??
    (capabilities.length === 1 && !explicitThreadId ? capabilities[0] : null);
  if (!capability) {
    throw new Error(buildCapabilityLookupError(capabilities, process.cwd(), explicitThreadId));
  }

  let action = "";
  let params = {};
  let directBrokerRequest = null;

  if (args[0] === "status") {
    action = "context";
  } else if (args[0] === "report") {
    action = "report";
    params = {
      status: readFlag(args, "--status"),
      summary: readFlag(args, "--summary"),
      details: readFlag(args, "--details"),
      turnId: readFlag(args, "--turn-id")
    };
  } else if (args[0] === "assist") {
    action = "assist.request";
    params = {
      summary: readFlag(args, "--summary"),
      details: readFlag(args, "--details"),
      question: readFlag(args, "--question")
    };
  } else if (args[0] === "preview") {
    const subcommand = args[1];
    if (subcommand === "list") {
      action = "preview.list";
    } else if (subcommand === "start") {
      action = "preview.start";
      const rawEnv = readRepeatedFlag(args, "--env");
      const env = Object.fromEntries(
        rawEnv
          .map((entry) => {
            const marker = entry.indexOf("=");
            return marker === -1 ? null : [entry.slice(0, marker), entry.slice(marker + 1)];
          })
          .filter(Boolean)
      );
      params = {
        title: readFlag(args, "--title"),
        cwd: readFlag(args, "--cwd"),
        stackId: readFlag(args, "--stack"),
        aliases: readRepeatedFlag(args, "--alias"),
        env,
        command: readFlag(args, "--command"),
        port: Number(readFlag(args, "--port", "0")),
        image: readFlag(args, "--image"),
        egressProfile: readFlag(args, "--egress-profile"),
        egressDomains: readRepeatedFlag(args, "--egress-domain"),
        bootstrapWaitSeconds: Number(readFlag(args, "--bootstrap-wait-seconds", "0")),
        bootstrapHint: readFlag(args, "--bootstrap-hint"),
        heartbeatKind: readFlag(args, "--heartbeat-kind"),
        heartbeatTarget: readFlag(args, "--heartbeat-target"),
        heartbeatIntervalSeconds: Number(readFlag(args, "--heartbeat-interval-seconds", "0"))
      };
    } else if (subcommand === "inspect" && args[2]) {
      action = "preview.inspect";
      params = { leaseId: args[2] };
    } else if (subcommand === "proof" && args[2]) {
      action = "preview.proof";
      params = {
        leaseId: args[2],
        runId: readFlag(args, "--run-id")
      };
    } else if (subcommand === "processes" && args[2]) {
      action = "preview.processes";
      params = { leaseId: args[2] };
    } else if (subcommand === "logs" && args[2]) {
      action = "preview.logs";
      params = { leaseId: args[2], tail: readTailArg(args) };
    } else if (subcommand === "exec" && args[2]) {
      const pipedInput = await readStdinIfPresent();
      const commandArgs = readCommandArgsAfterDoubleDash(args);
      action = "preview.exec";
      params = {
        leaseId: args[2],
        command: commandArgs.join(" ").trim(),
        commandArgs,
        cwd: readFlag(args, "--cwd"),
        stdin: pipedInput.stdin,
        stdinProvided: pipedInput.stdinProvided
      };
    } else if (subcommand === "verify" && args[2]) {
      const headers = Object.fromEntries(parseRepeatedKeyValueFlags(args, "--header"));
      const cookies = parseRepeatedKeyValueFlags(args, "--cookie");
      const sessionCookie = readFlag(args, "--session-cookie", "");
      const script = await readScriptValue(args);
      action = "preview.verify";
      params = {
        leaseId: args[2],
        mode: readFlag(args, "--mode"),
        path: readFlag(args, "--path"),
        waitForSelector: readFlag(args, "--wait-for"),
        postLoadWaitMs: readPositiveIntFlag(args, "--wait-ms"),
        headers,
        cookies: Object.fromEntries(cookies),
        sessionCookie,
        script
      };
    } else if (subcommand === "stop" && args[2]) {
      action = "preview.stop";
      params = { leaseId: args[2] };
    }
  } else if (args[0] === "service") {
    const subcommand = args[1];
    if (subcommand === "templates") {
      action = "service.templates";
    } else if (subcommand === "list") {
      action = "service.list";
    } else if (subcommand === "start") {
      const rawEnv = readRepeatedFlag(args, "--env");
      const env = Object.fromEntries(
        rawEnv
          .map((entry) => {
            const marker = entry.indexOf("=");
            return marker === -1 ? null : [entry.slice(0, marker), entry.slice(marker + 1)];
          })
          .filter(Boolean)
      );
      action = "service.start";
      params = {
        templateId: readFlag(args, "--template"),
        title: readFlag(args, "--title"),
        cwd: readFlag(args, "--cwd"),
        stackId: readFlag(args, "--stack"),
        aliases: readRepeatedFlag(args, "--alias"),
        env
      };
    } else if (subcommand === "inspect" && args[2]) {
      action = "service.inspect";
      params = { serviceId: args[2] };
    } else if (subcommand === "processes" && args[2]) {
      action = "service.processes";
      params = { serviceId: args[2] };
    } else if (subcommand === "logs" && args[2]) {
      action = "service.logs";
      params = { serviceId: args[2], tail: readTailArg(args) };
    } else if (subcommand === "exec" && args[2]) {
      const pipedInput = await readStdinIfPresent();
      const commandArgs = readCommandArgsAfterDoubleDash(args);
      action = "service.exec";
      params = {
        serviceId: args[2],
        command: commandArgs.join(" ").trim(),
        commandArgs,
        cwd: readFlag(args, "--cwd"),
        stdin: pipedInput.stdin,
        stdinProvided: pipedInput.stdinProvided
      };
    } else if (subcommand === "stop" && args[2]) {
      action = "service.stop";
      params = { serviceId: args[2] };
    }
  } else if (args[0] === "stack") {
    const subcommand = args[1];
    if (subcommand === "list") {
      action = "stack.list";
    } else if (subcommand === "start") {
      action = args.includes("--stateful") ? "stack.start_stateful" : "stack.start";
      params = {
        title: readFlag(args, "--title"),
        cwd: readFlag(args, "--cwd"),
        storageMode: readFlag(args, "--storage-mode"),
        retainsVolumes: args.includes("--retain-volumes"),
        storageKey: readFlag(args, "--storage-key"),
        cloneFromStorageKey: readFlag(args, "--clone-from")
      };
    } else if (subcommand === "inspect" && args[2]) {
      action = "stack.inspect";
      params = { stackId: args[2] };
    } else if (subcommand === "promote" && args[2]) {
      action = "stack.promote";
      params = { stackId: args[2], targetStorageKey: readFlag(args, "--to") };
    } else if (subcommand === "stop" && args[2]) {
      action = "stack.stop";
      params = { stackId: args[2], dropVolumes: args.includes("--drop-volumes") };
    }
  }

  if (!action && !directBrokerRequest) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (directBrokerRequest) {
    const result = await callBroker(capability.token, directBrokerRequest.path, {
      method: directBrokerRequest.method,
      body: directBrokerRequest.body ? JSON.stringify(directBrokerRequest.body) : undefined
    });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (directBrokerRequest.path.includes("/processes")) {
      console.log(formatProcessRows(result));
      return;
    }

    if (directBrokerRequest.path.includes("/logs")) {
      console.log(result.logs || "No logs were returned.");
      return;
    }

    if (directBrokerRequest.path.endsWith("/exec")) {
      console.log(formatExecResult(result));
      return;
    }

    if (directBrokerRequest.path.startsWith("/leases/")) {
      const domains = Array.isArray(result.egressDomains) && result.egressDomains.length > 0 ? result.egressDomains.join(", ") : "(none)";
      console.log(`${result.title} is ${result.runtime?.status || result.status}. Route=${result.operatorUrl}. Egress=${result.egressProfile}. Domains=${domains}.`);
      return;
    }

    if (directBrokerRequest.path.startsWith("/services/")) {
      console.log(`${result.title} is ${result.runtime?.status || result.status}. Host=${result.targetHost} Port=${result.targetPort}.`);
      return;
    }
  } else {
    const result = await callHarness(capability.token, action, params);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.text || "");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
