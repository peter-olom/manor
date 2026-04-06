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
  manor-harness status
  manor-harness preview list
  manor-harness preview start --command "<cmd>" --port <port> [--title <title>] [--cwd <path>] [--image <image>] [--egress-profile <name>] [--egress-domain <domain> ...]
  manor-harness preview inspect <leaseId>
  manor-harness preview processes <leaseId>
  manor-harness preview logs <leaseId> [--tail <n>]
  manor-harness preview exec <leaseId> -- <command>
  manor-harness preview verify <leaseId>
  manor-harness preview stop <leaseId>
  manor-harness service templates
  manor-harness service list
  manor-harness service start --template <id> [--title <title>] [--cwd <path>] [--env KEY=VALUE ...]
  manor-harness service inspect <serviceId>
  manor-harness service processes <serviceId>
  manor-harness service logs <serviceId> [--tail <n>]
  manor-harness service exec <serviceId> -- <command>
  manor-harness service stop <serviceId>

Add --json to print the Butler response payload as JSON.`);
}

async function loadCapabilities() {
  const raw = await fs.readFile(registryPath, "utf8").catch(() => "");
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.capabilities) ? parsed.capabilities : [];
}

function matchCapability(capabilities, cwd) {
  const normalizedCwd = path.resolve(cwd);
  const matches = capabilities.filter((entry) => {
    if (!entry || typeof entry.cwd !== "string" || typeof entry.token !== "string") {
      return false;
    }
    const capabilityCwd = path.resolve(entry.cwd);
    return normalizedCwd === capabilityCwd || normalizedCwd.startsWith(`${capabilityCwd}${path.sep}`);
  });

  return matches.sort((left, right) => String(right.cwd).length - String(left.cwd).length)[0] ?? null;
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

function readTailArg(args) {
  const raw = readFlag(args, "--tail", "200");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 200;
}

function readCommandAfterDoubleDash(args) {
  const marker = args.indexOf("--");
  if (marker === -1) {
    return "";
  }
  return args.slice(marker + 1).join(" ").trim();
}

async function main() {
  const args = process.argv.slice(2);
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
  const capability = matchCapability(capabilities, process.cwd());
  if (!capability) {
    throw new Error("No Manor harness capability is available for this workspace. Open this job through Butler first.");
  }

  let action = "";
  let params = {};
  let directBrokerRequest = null;

  if (args[0] === "status") {
    action = "context";
  } else if (args[0] === "preview") {
    const subcommand = args[1];
    if (subcommand === "list") {
      action = "preview.list";
    } else if (subcommand === "start") {
      action = "preview.start";
      params = {
        title: readFlag(args, "--title"),
        cwd: readFlag(args, "--cwd"),
        command: readFlag(args, "--command"),
        port: Number(readFlag(args, "--port", "0")),
        image: readFlag(args, "--image"),
        egressProfile: readFlag(args, "--egress-profile"),
        egressDomains: readRepeatedFlag(args, "--egress-domain")
      };
    } else if (subcommand === "inspect" && args[2]) {
      directBrokerRequest = { path: `/leases/${encodeURIComponent(args[2])}` };
    } else if (subcommand === "processes" && args[2]) {
      directBrokerRequest = { path: `/leases/${encodeURIComponent(args[2])}/processes` };
    } else if (subcommand === "logs" && args[2]) {
      directBrokerRequest = { path: `/leases/${encodeURIComponent(args[2])}/logs?tail=${encodeURIComponent(String(readTailArg(args)))}` };
    } else if (subcommand === "exec" && args[2]) {
      directBrokerRequest = {
        path: `/leases/${encodeURIComponent(args[2])}/exec`,
        method: "POST",
        body: {
          command: readCommandAfterDoubleDash(args),
          cwd: readFlag(args, "--cwd")
        }
      };
    } else if (subcommand === "verify" && args[2]) {
      action = "preview.verify";
      params = { leaseId: args[2] };
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
        env
      };
    } else if (subcommand === "inspect" && args[2]) {
      directBrokerRequest = { path: `/services/${encodeURIComponent(args[2])}` };
    } else if (subcommand === "processes" && args[2]) {
      directBrokerRequest = { path: `/services/${encodeURIComponent(args[2])}/processes` };
    } else if (subcommand === "logs" && args[2]) {
      directBrokerRequest = { path: `/services/${encodeURIComponent(args[2])}/logs?tail=${encodeURIComponent(String(readTailArg(args)))}` };
    } else if (subcommand === "exec" && args[2]) {
      directBrokerRequest = {
        path: `/services/${encodeURIComponent(args[2])}/exec`,
        method: "POST",
        body: {
          command: readCommandAfterDoubleDash(args),
          cwd: readFlag(args, "--cwd")
        }
      };
    } else if (subcommand === "stop" && args[2]) {
      action = "service.stop";
      params = { serviceId: args[2] };
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
