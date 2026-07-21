import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import { syncManorPiModelsJson } from "./model-provider-config.js";

type AuthCheckClient = Pick<RpcClient, "start" | "stop" | "promptAndWait" | "getMessages">;

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

export async function runPiRpcAuthCheck(options: {
  piAuthPath: string;
  sessionRootDir: string;
  cliPath: string;
  provider: string;
  model: string;
  timeoutMs: number;
  createClient?: (options: ConstructorParameters<typeof RpcClient>[0]) => AuthCheckClient;
}): Promise<string> {
  await syncManorPiModelsJson(options.piAuthPath);
  const checkId = `pi-auth-check-${crypto.randomUUID()}`;
  const sessionDir = path.join(options.sessionRootDir, checkId);
  await mkdir(sessionDir, { recursive: true });
  const client = (options.createClient ?? ((clientOptions) => new RpcClient(clientOptions)))({
    cwd: "/repos",
    cliPath: options.cliPath,
    env: {
      PI_AGENT_DIR: path.dirname(options.piAuthPath),
      PI_CODING_AGENT_DIR: path.dirname(options.piAuthPath),
      MANOR_THREAD_ID: checkId
    },
    provider: options.provider,
    model: options.model,
    args: [
      "--session-dir", sessionDir,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--system-prompt", "Reply briefly. This is an authentication check."
    ]
  });
  try {
    await client.start();
    await client.promptAndWait("hi", undefined, options.timeoutMs);
    const messages = await client.getMessages() as Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }>;
    const reply = [...messages].reverse().find((message) => message.role === "assistant");
    if (reply?.stopReason === "error" || reply?.stopReason === "aborted") {
      throw new Error(reply.errorMessage?.trim() || "Worker authentication check failed.");
    }
    return messageText(reply?.content);
  } finally {
    await client.stop().catch(() => undefined);
    await rm(sessionDir, { recursive: true, force: true });
  }
}
