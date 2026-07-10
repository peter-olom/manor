import path from "node:path";

import { captureGitReviewBaseline, cleanupGitReviewBaseline } from "./git-review-scope.js";
import type { ButlerStateStore } from "./state-store.js";
import type { WorkerReviewBaselineState } from "./state-store-worker-reports.js";

export async function rotateWorkerReviewBaseline(store: ButlerStateStore, threadId: string, artifactsDir: string, options: { flush?: () => Promise<void> } = {}): Promise<boolean> {
  const contract = store.getThread(threadId)?.executionContract;
  const cwd = contract?.reviewBaselineCwd ?? contract?.workspaceCwd;
  if (!contract || !cwd) return false;
  const baseline = await captureGitReviewBaseline(cwd, path.join(artifactsDir, "review-baselines")).catch(() => null);
  if (!baseline) return false;
  const prior: WorkerReviewBaselineState = {
    cwd: contract.reviewBaselineCwd ?? null,
    sha: contract.reviewBaselineSha ?? null,
    treeSha: contract.reviewBaselineTreeSha ?? null,
    objectDir: contract.reviewBaselineObjectDir ?? null,
    peerContexts: [...(contract.reviewPeerContexts ?? [])],
    peerContextOverflow: contract.reviewPeerContextOverflow === true
  };
  store.replaceWorkerReviewBaseline(threadId, { cwd: baseline.cwd, sha: baseline.sha, treeSha: baseline.treeSha, objectDir: baseline.objectDir, peerContexts: [], peerContextOverflow: false });
  try {
    await (options.flush ?? (() => store.flushSave()))();
  } catch {
    store.replaceWorkerReviewBaseline(threadId, prior);
    await store.flushSave().catch(() => undefined);
    await cleanupGitReviewBaseline(baseline.objectDir).catch(() => undefined);
    return false;
  }
  if (prior.objectDir !== baseline.objectDir) await cleanupGitReviewBaseline(prior.objectDir).catch(() => undefined);
  return true;
}
