import { promises as fs } from "node:fs";
import path from "node:path";

import type { HostControllerClient } from "./host-controller-client.js";
import { resolveGitRoot } from "./repo-worktree.js";
import type { SelfImprovementEligibilityView } from "../shared/self-improvement.js";

const DEFAULT_SOURCE_CWD = "/repos/manor";

function sourceCwd(): string {
  return path.resolve(process.env.MANOR_SELF_IMPROVEMENT_SOURCE_CWD ?? DEFAULT_SOURCE_CWD);
}

async function pathWritable(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.manor-self-improvement-probe-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function resolveSelfImprovementEligibility(hostController: HostControllerClient): Promise<SelfImprovementEligibilityView> {
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
  if (!await pathWritable(source)) reasons.push(`Mounted source is not writable at ${source}.`);
  if (!await resolveGitRoot(source)) reasons.push("Mounted source is not a Git checkout.");

  return { enabled: reasons.length === 0, sourceCwd: source, reasons };
}
