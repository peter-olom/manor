import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SelfImprovementRequestState } from "./self-improvement-request-state.js";
import type { PairStore } from "./pair-store.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import type { ButlerStateStore } from "./state-store.js";
import { buildSelfImprovementTask } from "./butler-self-improvement.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import { stopWorkerThread, type WorkerClientAccess } from "./worker-client-router.js";
import type { SelfImprovementRequestView } from "../shared/self-improvement.js";

const execFileAsync = promisify(execFile);
type SelfImprovementPairLifecycle = Pick<PairSessionManager, "quiescePair" | "resumePair" | "deletePair">;
let selfImprovementPairLifecycle: SelfImprovementPairLifecycle | null = null;
const selfImprovementActionTails = new Map<string, Promise<void>>();

export function configureSelfImprovementPairCleanup(lifecycle: SelfImprovementPairLifecycle | null): void {
  selfImprovementPairLifecycle = lifecycle;
}

export async function runSerializedSelfImprovementAction<T>(requestId: string, action: () => Promise<T>): Promise<T> {
  const previous = selfImprovementActionTails.get(requestId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  selfImprovementActionTails.set(requestId, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (selfImprovementActionTails.get(requestId) === tail) selfImprovementActionTails.delete(requestId);
  }
}

export async function reconcileInterruptedSelfImprovementRequests(
  requests: SelfImprovementRequestState,
  store: Pick<ButlerStateStore, "getThread" | "getWorkerReport">,
  pairStore: Pick<PairStore, "getPair" | "findPairByWorkerThread"> & Partial<Pick<PairStore, "attachWorker" | "flushPendingSave">>,
  pairSessions: Pick<PairSessionManager, "createWorkerPair">,
  canConcludeThreadMissing: (threadId: string) => boolean = () => true
): Promise<void> {
  const reconcileRequest = async (requestId: string): Promise<boolean> => {
    let request = requests.get(requestId);
    if (!request || !["approved", "running", "changes_ready", "committed"].includes(request.status)) return false;
    let handoffRecovered = false;
    let requestedPair = request.pairId ? pairStore.getPair(request.pairId) : null;
    if (request.threadId && requestedPair?.worker && requestedPair.worker.threadId !== request.threadId) {
      const pairWorkerThreadId = requestedPair.worker.threadId;
      const pairIsAhead = requestedPair.worker.handedOffFrom?.threadId === request.threadId && Boolean(store.getThread(pairWorkerThreadId));
      if (pairIsAhead) {
        request = requests.update(request.id, {
          status: "running",
          threadId: pairWorkerThreadId,
          startedAt: Date.now(),
          completedAt: null,
          commitSha: null,
          pullRequestUrl: null
        });
        await requests.flush();
        handoffRecovered = true;
      } else if (request.workerThreadIds.includes(pairWorkerThreadId) && pairStore.attachWorker && pairStore.flushPendingSave) {
        try {
          const repaired = pairStore.attachWorker(requestedPair.id, {
            threadId: request.threadId,
            task: buildSelfImprovementTask({ request }),
            cwd: request.workspaceCwd,
            handoffPrompt: buildSelfImprovementTask({ request }),
            replacesThreadId: pairWorkerThreadId
          });
          if (repaired?.worker?.threadId !== request.threadId) throw new Error("pair attachment was rejected");
          await pairStore.flushPendingSave();
          requestedPair = repaired;
          handoffRecovered = true;
        } catch (error) {
          console.error(`Could not repair self-improvement handoff pair ${requestedPair.id}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      }
    }
    const requestCanReturnToPending = request.status === "approved" || request.status === "running";
    const report = request.threadId ? store.getWorkerReport(request.threadId) : null;
    const threadExists = Boolean(request.threadId && store.getThread(request.threadId));
    const workerPair = request.threadId ? pairStore.findPairByWorkerThread(request.threadId) : null;
    let pair = requestedPair?.worker?.threadId === request.threadId ? requestedPair : workerPair;
    let pairMatches = Boolean(pair?.worker && pair.worker.threadId === request.threadId);
    if (threadExists && !pairMatches && request.threadId) {
      try {
        pair = await pairSessions.createWorkerPair({
          title: `Self-improvement: ${request.trigger}`,
          defaultCwd: request.workspaceCwd,
          threadId: request.threadId,
          task: buildSelfImprovementTask({ request }),
          cwd: request.workspaceCwd
        });
        pairMatches = true;
      } catch (error) {
        console.error(`Could not reattach self-improvement Worker ${request.threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    if (report?.status === "completed") {
      const pairLinkChanged = pairMatches && request.pairId !== pair?.id;
      if (requestCanReturnToPending || pairLinkChanged) {
        requests.update(request.id, {
          ...(requestCanReturnToPending ? { status: "changes_ready", completedAt: report.updatedAt } : {}),
          ...(pairLinkChanged ? { pairId: pair?.id ?? null } : {})
        });
        return true;
      }
      return handoffRecovered;
    }
    if (!threadExists && !pairMatches) {
      if (!requestCanReturnToPending) {
        if (request.pairId && requestedPair?.worker?.threadId !== request.threadId) {
          requests.update(request.id, { pairId: null });
          return true;
        }
        return handoffRecovered;
      }
      if (request.threadId && !canConcludeThreadMissing(request.threadId)) return false;
      requests.update(request.id, {
        status: "pending",
        approvedAt: null,
        threadId: null,
        pairId: null,
        workspaceCwd: null,
        branchName: null,
        startedAt: null
      });
      return true;
    }
    if (pairMatches && request.pairId !== pair?.id) {
      requests.update(request.id, {
        pairId: pair?.id ?? null,
        ...(requestCanReturnToPending ? { status: "running", startedAt: request.startedAt ?? Date.now() } : {})
      });
      return true;
    }
    if (request.status === "approved") {
      requests.update(request.id, {
        status: "running",
        startedAt: request.startedAt ?? Date.now()
      });
      return true;
    }
    return handoffRecovered;
  };

  let changed = false;
  for (const request of requests.list()) {
    if (await runSerializedSelfImprovementAction(request.id, () => reconcileRequest(request.id))) changed = true;
  }
  if (changed) await requests.flush();
}

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
  const discardCurrent = async (expectedThreadId: string | null): Promise<{ retry: boolean; request: SelfImprovementRequestView | null }> => {
    return runSerializedSelfImprovementAction(requestId, async () => {
      const current = requests.get(requestId);
      if (!current) throw new Error("Self-improvement request was not found.");
      if (current.threadId !== expectedThreadId) return { retry: true, request: null };
      if (!["approved", "running", "changes_ready", "committed"].includes(current.status)) {
        throw new Error("Only approved or active self-improvement requests can be closed.");
      }
      if (current.pairId) {
        if (!selfImprovementPairLifecycle) throw new Error("Self-improvement pair cleanup is not available.");
        await selfImprovementPairLifecycle.quiescePair(current.pairId);
      }
      try {
        if (current.threadId) await stopWorkerThread(workerClient, current.threadId);
      } catch (error) {
        if (current.pairId && selfImprovementPairLifecycle) {
          try {
            await selfImprovementPairLifecycle.resumePair(current.pairId);
          } catch (resumeError) {
            throw new Error(
              `Worker stop failed and pair supervision could not be resumed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`,
              { cause: error }
            );
          }
        }
        throw error;
      }
      if (current.pairId) await selfImprovementPairLifecycle!.deletePair(current.pairId);
      const updated = requests.update(current.id, { status: "discarded", pairId: null, completedAt: Date.now() });
      await requests.flush();
      return { retry: false, request: updated };
    });
  };

  for (;;) {
    const expectedThreadId = requests.get(requestId)?.threadId ?? null;
    const result = expectedThreadId
      ? await runSerializedJobMutation(expectedThreadId, () => discardCurrent(expectedThreadId))
      : await discardCurrent(null);
    if (!result.retry && result.request) return result.request;
  }
}

export async function commitSelfImprovementRequest(
  requests: SelfImprovementRequestState,
  requestId: string,
  message: string
): Promise<SelfImprovementRequestView> {
  return await runSerializedSelfImprovementAction(requestId, async () => {
    const current = readWorkspaceRequest(requests, requestId);
    if (current.status !== "changes_ready") throw new Error("Self-improvement changes must be ready before they can be committed.");
    const normalizedMessage = message.trim();
    if (!normalizedMessage) throw new Error("A commit message is required.");
    await git(["add", "-A"], current.workspaceCwd);
    await git(["commit", "-m", normalizedMessage], current.workspaceCwd);
    const commitSha = await git(["rev-parse", "HEAD"], current.workspaceCwd);
    const updated = requests.update(current.id, { status: "committed", commitSha });
    await requests.flush();
    return updated;
  });
}

export async function openSelfImprovementPullRequest(
  requests: SelfImprovementRequestState,
  requestId: string,
  title: string | null,
  body: string | null
): Promise<SelfImprovementRequestView> {
  return await runSerializedSelfImprovementAction(requestId, async () => {
    const current = readWorkspaceRequest(requests, requestId);
    if (current.status !== "committed") throw new Error("Commit the self-improvement changes locally before opening a pull request.");
    if (!current.commitSha) throw new Error("The self-improvement request has no recorded commit.");
    const prTitle = title?.trim() || current.trigger;
    const prBody = body?.trim() || current.observations;
    const baseBranch = await git(["branch", "--show-current"], current.workspaceCwd);
    if (!baseBranch) throw new Error("The active Manor checkout is detached; choose a base branch before opening a pull request.");
    const branchName = `manor/self-improvement-${current.id.slice(0, 8)}`;
    let existingCommit = "";
    try {
      existingCommit = await git(["rev-parse", `refs/heads/${branchName}`], current.workspaceCwd);
    } catch {}
    if (existingCommit && existingCommit !== current.commitSha) {
      throw new Error(`The local pull-request branch ${branchName} already points to another commit.`);
    }
    if (!existingCommit) await git(["branch", branchName, current.commitSha], current.workspaceCwd);
    await git(["push", "--set-upstream", "origin", branchName], current.workspaceCwd);
    const { stdout } = await execFileAsync("gh", ["pr", "create", "--draft", "--head", branchName, "--base", baseBranch, "--title", prTitle, "--body", prBody], { cwd: current.workspaceCwd });
    const output = String(stdout).trim();
    const pullRequestUrl = output.split(/\s+/).find((part) => part.startsWith("http")) ?? output;
    const updated = requests.update(current.id, { status: "pr_opened", branchName, pullRequestUrl });
    await requests.flush();
    return updated;
  });
}
