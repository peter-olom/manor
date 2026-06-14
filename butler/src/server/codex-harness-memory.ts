import { normalizeString } from "./codex-harness-helpers.js";
import { formatMemoryDebugTrace, formatMemoryDebugTraceList, getMemoryDebugTrace, listMemoryDebugTraces } from "./memory-debug-traces.js";
import { buildMemoryDiagnostics, formatMemoryDiagnostics } from "./memory-diagnostics.js";
import { formatButlerMemoryRetrieval, retrieveButlerMemory } from "./memory-retrieval.js";
import type { ButlerStateStore } from "./state-store.js";

export function formatHarnessJobMemory(store: ButlerStateStore, threadId: string, options: { includeProvenance?: boolean } = {}): string[] {
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

  if (options.includeProvenance === true) {
    lines.unshift(
      `Job memory provenance: source=${jobMemory.source ?? "unknown"} | created=${new Date(jobMemory.createdAt).toISOString()} | updated=${new Date(jobMemory.updatedAt).toISOString()}`
    );
  }

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
    const includeProvenance = params.includeProvenance === true;
    return {
      text: [...formatHarnessJobMemory(store, threadId, { includeProvenance }), ...formatHarnessProjectMemory(store, projectId)].join("\n"),
      data: {
        jobMemory: store.getJobMemory(threadId),
        projectMemory: store.getProjectMemory(projectId),
        pendingPromotionCandidates: store.listPendingPromotionCandidates(projectId)
      }
    };
  }

  if (action === "memory.retrieve") {
    const scope = normalizeString(params.scope) === "job" ? "job" : "project";
    const retrieval = retrieveButlerMemory(store, {
      projectId,
      threadId: scope === "job" ? threadId : null,
      query: normalizeString(params.query) || null,
      limit: typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : null,
      includeGlobal: params.includeGlobal === true,
      includeProvenance: params.includeProvenance === true
    });
    return {
      text: formatButlerMemoryRetrieval(retrieval),
      data: { retrieval }
    };
  }

  if (action === "memory.diagnostics") {
    const scope = normalizeString(params.scope) === "job" ? "job" : "project";
    const allProjects = params.allProjects === true;
    const diagnostics = buildMemoryDiagnostics(store, {
      projectId: allProjects || scope === "job" ? null : normalizeString(params.projectId) || projectId,
      threadId: scope === "job" ? threadId : normalizeString(params.threadId) || null,
      from: typeof params.from === "string" || typeof params.from === "number" ? params.from : null,
      to: typeof params.to === "string" || typeof params.to === "number" ? params.to : null,
      includeSamples: params.includeSamples === true,
      sampleLimit: typeof params.sampleLimit === "number" && Number.isFinite(params.sampleLimit) ? params.sampleLimit : null
    });
    return {
      text: formatMemoryDiagnostics(diagnostics),
      data: { diagnostics }
    };
  }

  if (action === "memory.debug_trace") {
    const traceId = normalizeString(params.traceId) || null;
    if (traceId) {
      const trace = getMemoryDebugTrace(store, traceId);
      return trace
        ? { text: formatMemoryDebugTrace(trace), data: { trace } }
        : { text: "No memory debug trace matched.", data: { trace: null } };
    }
    const scope = normalizeString(params.scope) === "job" ? "job" : "project";
    const traces = listMemoryDebugTraces(store, {
      kind: normalizeString(params.kind) === "review" || normalizeString(params.kind) === "synthesis" ? (normalizeString(params.kind) as "review" | "synthesis") : null,
      status:
        normalizeString(params.status) === "completed" || normalizeString(params.status) === "failed" || normalizeString(params.status) === "skipped"
          ? (normalizeString(params.status) as "completed" | "failed" | "skipped")
          : null,
      projectId: params.allProjects === true || scope === "job" ? null : normalizeString(params.projectId) || projectId,
      threadId: scope === "job" ? threadId : normalizeString(params.threadId) || null,
      from: typeof params.from === "string" || typeof params.from === "number" ? params.from : null,
      to: typeof params.to === "string" || typeof params.to === "number" ? params.to : null,
      limit: typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : null
    });
    return { text: formatMemoryDebugTraceList(traces), data: { traces } };
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
