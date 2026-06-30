import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { cleanupManagedWorktree } from "./repo-worktree.js";
import type { SelfImprovementRequestState } from "./self-improvement-request-state.js";
import { stopWorkerThread, type WorkerClientAccess } from "./worker-client-router.js";
import type { SelfImprovementRequestView } from "../shared/self-improvement.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", ...args], { cwd });
  return String(stdout).trim();
}

function readWorkspaceRequest(requests: SelfImprovementRequestState, requestId: string): SelfImprovementRequestView & { workspaceCwd: string } {
  const current = requests.get(requestId);
  if (!current?.workspaceCwd) throw new Error("Self-improvement request has no local workspace.");
  return current as SelfImprovementRequestView & { workspaceCwd: string };
}

export async function discardSelfImprovementRequest(
  requests: SelfImprovementRequestState,
  workerClient: WorkerClientAccess,
  requestId: string
): Promise<SelfImprovementRequestView> {
  const current = requests.get(requestId);
  if (!current) throw new Error("Self-improvement request was not found.");
  if (current.threadId) await stopWorkerThread(workerClient, current.threadId).catch(() => undefined);
  if (current.workspaceCwd) await cleanupManagedWorktree(current.workspaceCwd);
  return requests.update(current.id, { status: "discarded", completedAt: Date.now() });
}

export async function commitSelfImprovementRequest(
  requests: SelfImprovementRequestState,
  requestId: string,
  message: string
): Promise<SelfImprovementRequestView> {
  const current = readWorkspaceRequest(requests, requestId);
  const normalizedMessage = message.trim();
  if (!normalizedMessage) throw new Error("A commit message is required.");
  await git(["add", "-A"], current.workspaceCwd);
  await git(["commit", "-m", normalizedMessage], current.workspaceCwd);
  const commitSha = await git(["rev-parse", "HEAD"], current.workspaceCwd);
  return requests.update(current.id, { status: "committed", commitSha });
}

export async function openSelfImprovementPullRequest(
  requests: SelfImprovementRequestState,
  requestId: string,
  title: string | null,
  body: string | null
): Promise<SelfImprovementRequestView> {
  const current = readWorkspaceRequest(requests, requestId);
  if (current.status !== "committed") throw new Error("Commit the self-improvement changes locally before opening a pull request.");
  const prTitle = title?.trim() || current.trigger;
  const prBody = body?.trim() || current.observations;
  const { stdout } = await execFileAsync("gh", ["pr", "create", "--draft", "--title", prTitle, "--body", prBody], { cwd: current.workspaceCwd });
  const output = String(stdout).trim();
  const pullRequestUrl = output.split(/\s+/).find((part) => part.startsWith("http")) ?? output;
  return requests.update(current.id, { status: "pr_opened", pullRequestUrl });
}
