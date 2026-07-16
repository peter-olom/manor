import { promises as fs } from "node:fs";
import path from "node:path";

import type { HostControllerClient } from "./host-controller-client.js";
import { resolveGitRoot } from "./repo-worktree.js";
import type { SelfImprovementEligibilityView } from "../shared/self-improvement.js";

const DEFAULT_SOURCE_CWD = "/repos/manor";

function sourceCwd(): string {
  return path.resolve(process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD ?? DEFAULT_SOURCE_CWD);
}

export async function resolveSelfImprovementEligibility(
  hostController: HostControllerClient,
  checkWorkerWorkspace: (cwd: string) => Promise<void> = async () => undefined
): Promise<SelfImprovementEligibilityView> {
  const source = sourceCwd();
  const reasons: string[] = [];

  try {
    await hostController.getStatus();
  } catch (error) {
    reasons.push(`Host controller status is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await fs.access(source);
  } catch {
    reasons.push(`Mounted source was not found at ${source}.`);
  }
  if (!await resolveGitRoot(source)) {
    reasons.push("Mounted source is not a Git checkout.");
  } else {
    try {
      await checkWorkerWorkspace(source);
    } catch (error) {
      reasons.push(`Mounted source is not ready for Worker edits and Git operations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { enabled: reasons.length === 0, sourceCwd: source, reasons };
}
