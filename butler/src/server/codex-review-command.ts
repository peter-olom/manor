import { spawn } from "node:child_process";

export interface CodexExecReviewCommandInput {
  schemaPath?: string | null;
  outputLastMessagePath?: string | null;
  model?: string | null;
  cwd?: string | null;
  prompt: string;
  timeoutMs?: number;
}

export interface CodexExecReviewCommand {
  command: "codex";
  args: string[];
  stdin: string;
}

export interface CodexExecReviewResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function appendOptionalPath(args: string[], flag: string, value: string | null | undefined): void {
  if (typeof value === "string" && value.trim()) {
    args.push(flag, value);
  }
}

export function buildUncommittedCodexExecReviewCommand(input: CodexExecReviewCommandInput): CodexExecReviewCommand {
  const args = [
    "exec",
    "review",
    "--uncommitted",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules"
  ];

  appendOptionalPath(args, "--output-schema", input.schemaPath);
  appendOptionalPath(args, "--output-last-message", input.outputLastMessagePath);
  appendOptionalPath(args, "--model", input.model);
  return {
    command: "codex",
    args,
    stdin: input.prompt
  };
}

export async function runUncommittedCodexExecReview(input: CodexExecReviewCommandInput): Promise<CodexExecReviewResult> {
  const invocation = buildUncommittedCodexExecReviewCommand(input);
  const timeoutMs = input.timeoutMs ?? 120_000;

  return await new Promise<CodexExecReviewResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd ?? process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("codex exec review timed out"));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      reject(new Error(`codex exec review exited with ${exitCode}: ${stderr || stdout}`.trim()));
    });
    child.stdin.end(invocation.stdin);
  });
}
