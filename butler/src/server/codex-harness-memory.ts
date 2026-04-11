import { normalizeString } from "./codex-harness-helpers.js";
import type { ButlerStateStore } from "./state-store.js";

export function formatHarnessJobMemory(store: ButlerStateStore, threadId: string): string[] {
  const jobMemory = store.getJobMemory(threadId);
  if (!jobMemory) {
    return ["Job memory: none"];
  }

  const lines = [
    `Job memory goal: ${jobMemory.operatorGoal ?? jobMemory.requestedTask ?? "(none)"}`,
    `Job memory checkpoint: ${jobMemory.latestCheckpoint ?? "(none)"}`,
    `Job memory next action: ${jobMemory.nextAction ?? "(none)"}`,
    `Job memory blockers: ${jobMemory.blockers.length > 0 ? jobMemory.blockers.join(" | ") : "(none)"}`,
    `Job memory pending promotions: ${jobMemory.promotionCandidates.filter((candidate) => candidate.status === "pending").length}`
  ];

  if (jobMemory.currentPlan.length > 0) {
    lines.push(`Job memory plan:\n${jobMemory.currentPlan.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }

  if (jobMemory.decisions.length > 0) {
    lines.push(`Job memory decisions:\n${jobMemory.decisions.slice(-3).map((entry, index) => `${index + 1}. ${entry.summary}`).join("\n")}`);
  }

  return lines;
}

export function formatHarnessProjectMemory(store: ButlerStateStore, projectId: string): string[] {
  const projectMemory = store.getProjectMemory(projectId);
  const pending = store.listPendingPromotionCandidates(projectId);
  if (!projectMemory && pending.length === 0) {
    return ["Project memory: none"];
  }

  const lines = [
    `Project memory summary: ${projectMemory?.summary ?? "(none)"}`,
    `Project memory pending promotions: ${pending.length}`
  ];

  if (projectMemory && projectMemory.entries.length > 0) {
    lines.push(
      `Project memory entries:\n${projectMemory.entries
        .slice(-5)
        .map((entry, index) => `${index + 1}. ${entry.kind} | ${entry.summary}`)
        .join("\n")}`
    );
  }

  if (pending.length > 0) {
    lines.push(
      `Project memory promotion candidates:\n${pending
        .slice(0, 5)
        .map((entry, index) => `${index + 1}. ${entry.id} | ${entry.kind} | ${entry.summary}`)
        .join("\n")}`
    );
  }

  return lines;
}

export function handleHarnessMemoryAction(input: {
  action: string;
  threadId: string;
  projectId: string;
  store: ButlerStateStore;
  params: Record<string, unknown>;
}): { text: string; data?: Record<string, unknown> } | null {
  const { action, threadId, projectId, store, params } = input;

  if (action === "memory.context") {
    return {
      text: [...formatHarnessJobMemory(store, threadId), ...formatHarnessProjectMemory(store, projectId)].join("\n"),
      data: {
        jobMemory: store.getJobMemory(threadId),
        projectMemory: store.getProjectMemory(projectId),
        pendingPromotionCandidates: store.listPendingPromotionCandidates(projectId)
      }
    };
  }

  if (action === "memory.checkpoint") {
    const summary = normalizeString(params.summary);
    if (!summary) {
      throw new Error("memory.checkpoint requires a non-empty summary");
    }
    const memory = store.recordJobCheckpoint(threadId, {
      summary,
      details: normalizeString(params.details) || null,
      nextAction: normalizeString(params.nextAction) || null,
      blockers: Array.isArray(params.blockers) ? params.blockers.filter((entry): entry is string => typeof entry === "string") : [],
      plan: Array.isArray(params.plan) ? params.plan.filter((entry): entry is string => typeof entry === "string") : [],
      assumptions: Array.isArray(params.assumptions)
        ? params.assumptions.filter((entry): entry is string => typeof entry === "string")
        : [],
      proofRequirements: Array.isArray(params.proofRequirements)
        ? params.proofRequirements.filter((entry): entry is string => typeof entry === "string")
        : [],
      promote: Boolean(params.promote)
    });
    store.addEvent(threadId, "harness/memory/checkpoint", summary);
    return {
      text: `Recorded a job memory checkpoint for ${threadId}.`,
      data: { jobMemory: memory }
    };
  }

  if (action === "memory.decision") {
    const summary = normalizeString(params.summary);
    if (!summary) {
      throw new Error("memory.decision requires a non-empty summary");
    }
    const memory = store.recordJobDecision(threadId, {
      summary,
      details: normalizeString(params.details) || null,
      promote: Boolean(params.promote)
    });
    store.addEvent(threadId, "harness/memory/decision", summary);
    return {
      text: `Recorded a job memory decision for ${threadId}.`,
      data: { jobMemory: memory }
    };
  }

  if (action === "memory.note") {
    const summary = normalizeString(params.summary);
    if (!summary) {
      throw new Error("memory.note requires a non-empty summary");
    }
    const memory = store.recordJobNote(threadId, {
      summary,
      details: normalizeString(params.details) || null,
      promote: Boolean(params.promote)
    });
    store.addEvent(threadId, "harness/memory/note", summary);
    return {
      text: `Recorded a job memory note for ${threadId}.`,
      data: { jobMemory: memory }
    };
  }

  if (action === "memory.promote") {
    const summary = normalizeString(params.summary);
    const kind = normalizeString(params.kind);
    if (!summary || (kind !== "checkpoint" && kind !== "decision" && kind !== "note")) {
      throw new Error("memory.promote requires kind=checkpoint|decision|note and a non-empty summary");
    }
    const candidate = store.submitJobMemoryPromotionCandidate(threadId, {
      kind,
      summary,
      details: normalizeString(params.details) || null,
      sourceEntryId: `manual-${Date.now()}`
    });
    store.addEvent(threadId, "harness/memory/promotion", summary);
    return {
      text: `Submitted a project memory promotion candidate for ${threadId}.`,
      data: { candidate }
    };
  }

  return null;
}
