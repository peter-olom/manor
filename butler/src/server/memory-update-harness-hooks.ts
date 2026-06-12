import crypto from "node:crypto";

import { normalizeString } from "./codex-harness-helpers.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { MemoryObservationSourceKind } from "./types.js";

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function observeHarnessMemoryAction(scheduler: MemoryUpdateScheduler | null, input: { action: string; threadId: string; params: Record<string, unknown> }): void {
  if (!scheduler || (input.action !== "memory.checkpoint" && input.action !== "memory.decision" && input.action !== "memory.note")) return;
  scheduler.observeHarnessMemory({
    threadId: input.threadId,
    kind: input.action === "memory.checkpoint" ? "checkpoint" : input.action === "memory.decision" ? "decision" : "note",
    summary: normalizeString(input.params.summary),
    details: normalizeString(input.params.details) || null,
    payload: {
      nextAction: normalizeString(input.params.nextAction) || null,
      blockers: stringList(input.params.blockers),
      plan: stringList(input.params.plan),
      assumptions: stringList(input.params.assumptions),
      proofRequirements: stringList(input.params.proofRequirements)
    }
  });
}

export function observeHarnessArtifactPolicyAction(
  scheduler: MemoryUpdateScheduler | null,
  input: { action: string; threadId: string; projectId: string; projectLabel: string; params: Record<string, unknown> }
): void {
  if (!scheduler) return;
  const sourceKind: MemoryObservationSourceKind | null = input.action.startsWith("proof.")
    ? "proof_saved"
    : input.action.startsWith("policy.")
      ? "policy_saved"
      : input.action.startsWith("artifact.")
        ? "artifact_saved"
        : null;
  if (!sourceKind) return;
  scheduler.recordMemoryEvent({
    idempotencyKey: `${sourceKind}:${input.threadId}:${input.action}:${crypto.createHash("sha256").update(JSON.stringify(input.params)).digest("hex").slice(0, 16)}`,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    threadId: input.threadId,
    sourceKind,
    sourceId: input.action,
    summary: `${input.action} recorded for job ${input.threadId.slice(0, 8)}.`,
    payload: { action: input.action, params: input.params }
  }, { semanticReview: sourceKind === "policy_saved" ? "high" : "normal", reason: sourceKind.replace(/_/g, " ") });
}
