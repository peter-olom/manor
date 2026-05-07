import crypto from "node:crypto";

import { buildEmptyJobMemory, deriveProofRequirements, normalizeStringList } from "./state-store-helpers.js";
import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import type {
  CodexThreadRecord,
  JobMemoryEntryKind,
  JobMemoryPromotionCandidateView,
  JobMemoryView,
  ProjectMemoryEntryView,
  ProjectMemoryView
} from "./types.js";

export function syncStateStoreThreadJobMemory(access: StateStoreInternalAccess, thread: CodexThreadRecord): JobMemoryView {
  const fallbackProjectId =
    thread.executionContract?.projectId ??
    (thread.supervisor.projectId && thread.supervisor.projectId !== "unknown" ? thread.supervisor.projectId : "unknown");
  const fallbackProjectLabel =
    thread.executionContract?.projectLabel ??
    (thread.supervisor.projectLabel && thread.supervisor.projectLabel !== "Unknown" ? thread.supervisor.projectLabel : fallbackProjectId);
  const current =
    thread.jobMemory ??
    buildEmptyJobMemory({ threadId: thread.id, projectId: fallbackProjectId, projectLabel: fallbackProjectLabel, contract: thread.executionContract });
  const projectId =
    thread.supervisor.projectId && thread.supervisor.projectId !== "unknown"
      ? thread.supervisor.projectId
      : thread.executionContract?.projectId ?? current.projectId ?? "unknown";
  const projectLabel =
    thread.supervisor.projectLabel && thread.supervisor.projectLabel !== "Unknown"
      ? thread.supervisor.projectLabel
      : thread.executionContract?.projectLabel ?? current.projectLabel ?? projectId ?? "Unknown";
  const nextMemory: JobMemoryView = {
    ...current,
    threadId: thread.id,
    projectId,
    projectLabel,
    operatorGoal: thread.executionContract?.operatorGoal ?? current.operatorGoal ?? null,
    requestedTask: thread.executionContract?.requestedTask ?? current.requestedTask ?? thread.supervisor.latestUserPrompt ?? null,
    proofRequirements:
      current.proofRequirements.length > 0 ? current.proofRequirements : deriveProofRequirements(thread.executionContract ?? null),
    updatedAt: Math.max(current.updatedAt, thread.updatedAt)
  };
  thread.jobMemory = nextMemory;
  access.persistedJobMemoriesByThreadId.set(thread.id, cloneJobMemory(nextMemory));
  return nextMemory;
}

export function getStateStoreJobMemory(access: StateStoreInternalAccess, threadId: string): JobMemoryView | null {
  const thread = access.threads.get(threadId);
  if (thread) {
    return syncStateStoreThreadJobMemory(access, thread);
  }

  const persisted = access.persistedJobMemoriesByThreadId.get(threadId);
  return persisted ? cloneJobMemory(persisted) : null;
}

export function getStateStoreProjectMemory(access: StateStoreInternalAccess, projectId: string): ProjectMemoryView | null {
  const memory = access.persistedProjectMemoriesByProjectId.get(projectId);
  return memory ? { ...memory, entries: [...memory.entries] } : null;
}

export function listStateStoreProjectMemories(access: StateStoreInternalAccess): ProjectMemoryView[] {
  return [...access.persistedProjectMemoriesByProjectId.values()]
    .map((memory) => ({ ...memory, entries: [...memory.entries] }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function listStateStoreJobMemories(access: StateStoreInternalAccess, projectId?: string | null): JobMemoryView[] {
  for (const thread of access.threads.values()) {
    syncStateStoreThreadJobMemory(access, thread);
  }
  return [...access.persistedJobMemoriesByThreadId.values()]
    .filter((memory) => !projectId || memory.projectId === projectId)
    .map((memory) => cloneJobMemory(memory))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function listStateStorePendingPromotionCandidates(
  access: StateStoreInternalAccess,
  projectId?: string | null
): JobMemoryPromotionCandidateView[] {
  return listStateStoreJobMemories(access, projectId)
    .flatMap((memory) => memory.promotionCandidates)
    .filter((candidate) => candidate.status === "pending" && (!projectId || candidate.projectId === projectId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function cloneJobMemory(memory: JobMemoryView): JobMemoryView {
  return {
    ...memory,
    currentPlan: [...memory.currentPlan],
    blockers: [...memory.blockers],
    assumptions: [...memory.assumptions],
    proofRequirements: [...memory.proofRequirements],
    notes: [...memory.notes],
    decisions: memory.decisions.map((entry) => ({ ...entry })),
    entries: memory.entries.map((entry) => ({
      ...entry,
      blockers: [...entry.blockers],
      plan: [...entry.plan],
      assumptions: [...entry.assumptions],
      proofRequirements: [...entry.proofRequirements]
    })),
    promotionCandidates: memory.promotionCandidates.map((entry) => ({ ...entry }))
  };
}

function getOrCreateProjectMemory(access: StateStoreInternalAccess, projectId: string, projectLabel: string): ProjectMemoryView {
  const existing = access.persistedProjectMemoriesByProjectId.get(projectId);
  if (existing) {
    if (existing.projectLabel !== projectLabel && projectLabel.trim()) {
      const next = { ...existing, projectLabel: projectLabel.trim(), updatedAt: Math.max(existing.updatedAt, Date.now()) };
      access.persistedProjectMemoriesByProjectId.set(projectId, next);
      return next;
    }
    return existing;
  }

  const created = {
    projectId,
    projectLabel,
    summary: null,
    entries: [],
    updatedAt: Date.now()
  };
  access.persistedProjectMemoriesByProjectId.set(projectId, created);
  return created;
}

function submitStateStoreJobMemoryPromotionCandidate(
  access: StateStoreInternalAccess,
  threadId: string,
  candidate: {
    kind: JobMemoryEntryKind;
    summary: string;
    details?: string | null;
    sourceEntryId: string;
  },
  options?: { save?: boolean }
): JobMemoryPromotionCandidateView {
  const thread = access.getOrCreateThread(threadId);
  const jobMemory = syncStateStoreThreadJobMemory(access, thread);
  const now = Date.now();
  const nextCandidate: JobMemoryPromotionCandidateView = {
    id: crypto.randomUUID(),
    threadId,
    projectId: jobMemory.projectId,
    projectLabel: jobMemory.projectLabel,
    kind: candidate.kind,
    sourceEntryId: candidate.sourceEntryId,
    summary: candidate.summary.trim(),
    details: typeof candidate.details === "string" && candidate.details.trim() ? candidate.details.trim() : null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  };
  const nextMemory: JobMemoryView = {
    ...jobMemory,
    promotionCandidates: [...jobMemory.promotionCandidates, nextCandidate].slice(-20),
    updatedAt: now
  };
  thread.jobMemory = nextMemory;
  access.persistedJobMemoriesByThreadId.set(threadId, { ...nextMemory });
  access.refreshDerivedThreadState(thread, now);
  if (options?.save !== false) {
    queueStateStoreSave(access);
    emitStateStoreChange(access);
  }
  return nextCandidate;
}

function appendStateStoreJobMemoryEntry(
  access: StateStoreInternalAccess,
  threadId: string,
  input: {
    kind: JobMemoryEntryKind;
    summary: string;
    details?: string | null;
    nextAction?: string | null;
    blockers?: string[];
    plan?: string[];
    assumptions?: string[];
    proofRequirements?: string[];
    promote?: boolean;
  }
): JobMemoryView {
  const thread = access.getOrCreateThread(threadId);
  const now = Date.now();
  const jobMemory = syncStateStoreThreadJobMemory(access, thread);
  const entryId = crypto.randomUUID();
  const entry = {
    id: entryId,
    kind: input.kind,
    summary: input.summary.trim(),
    details: typeof input.details === "string" && input.details.trim() ? input.details.trim() : null,
    nextAction: typeof input.nextAction === "string" && input.nextAction.trim() ? input.nextAction.trim() : null,
    blockers: normalizeStringList(input.blockers),
    plan: normalizeStringList(input.plan),
    assumptions: normalizeStringList(input.assumptions),
    proofRequirements: normalizeStringList(input.proofRequirements),
    promote: Boolean(input.promote),
    promotionCandidateId: null,
    at: now
  };

  const nextMemory: JobMemoryView = {
    ...jobMemory,
    currentPlan: entry.plan.length > 0 ? entry.plan : jobMemory.currentPlan,
    latestCheckpoint: input.kind === "checkpoint" ? entry.summary : jobMemory.latestCheckpoint,
    nextAction: entry.nextAction ?? jobMemory.nextAction,
    blockers: entry.blockers.length > 0 ? entry.blockers : jobMemory.blockers,
    assumptions: [...new Set([...jobMemory.assumptions, ...entry.assumptions])].slice(-20),
    proofRequirements: [...new Set([...jobMemory.proofRequirements, ...entry.proofRequirements])].slice(-20),
    notes:
      input.kind === "note" ? [...jobMemory.notes, [entry.summary, entry.details].filter(Boolean).join(" | ")].slice(-20) : jobMemory.notes,
    decisions:
      input.kind === "decision"
        ? [...jobMemory.decisions, { id: entry.id, summary: entry.summary, details: entry.details, at: now }].slice(-20)
        : jobMemory.decisions,
    entries: [...jobMemory.entries, entry].slice(-40),
    updatedAt: now
  };

  thread.jobMemory = nextMemory;
  access.persistedJobMemoriesByThreadId.set(threadId, { ...nextMemory });
  thread.updatedAt = Math.max(thread.updatedAt, now);

  if (entry.promote) {
    const candidate = submitStateStoreJobMemoryPromotionCandidate(
      access,
      threadId,
      {
        kind: entry.kind,
        summary: entry.summary,
        details: entry.details,
        sourceEntryId: entry.id
      },
      { save: false }
    );
    const persisted = access.persistedJobMemoriesByThreadId.get(threadId);
    if (persisted) {
      persisted.entries = persisted.entries.map((item) => (item.id === entry.id ? { ...item, promotionCandidateId: candidate.id } : item));
      thread.jobMemory = { ...persisted };
    }
  }

  access.refreshDerivedThreadState(thread, now);
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return thread.jobMemory ?? nextMemory;
}

export function recordStateStoreJobCheckpoint(
  access: StateStoreInternalAccess,
  threadId: string,
  checkpoint: {
    summary: string;
    details?: string | null;
    nextAction?: string | null;
    blockers?: string[];
    plan?: string[];
    assumptions?: string[];
    proofRequirements?: string[];
    promote?: boolean;
  }
): JobMemoryView {
  return appendStateStoreJobMemoryEntry(access, threadId, { kind: "checkpoint", ...checkpoint });
}

export function recordStateStoreJobDecision(
  access: StateStoreInternalAccess,
  threadId: string,
  decision: {
    summary: string;
    details?: string | null;
    promote?: boolean;
  }
): JobMemoryView {
  return appendStateStoreJobMemoryEntry(access, threadId, { kind: "decision", ...decision });
}

export function recordStateStoreJobNote(
  access: StateStoreInternalAccess,
  threadId: string,
  note: {
    summary: string;
    details?: string | null;
    promote?: boolean;
  }
): JobMemoryView {
  return appendStateStoreJobMemoryEntry(access, threadId, { kind: "note", ...note });
}

export function submitStateStorePromotionCandidate(
  access: StateStoreInternalAccess,
  threadId: string,
  candidate: {
    kind: JobMemoryEntryKind;
    summary: string;
    details?: string | null;
    sourceEntryId: string;
  }
): JobMemoryPromotionCandidateView {
  return submitStateStoreJobMemoryPromotionCandidate(access, threadId, candidate);
}

export function resolveStateStorePromotionCandidate(
  access: StateStoreInternalAccess,
  candidateId: string,
  accepted: boolean
): JobMemoryPromotionCandidateView | null {
  const now = Date.now();
  for (const jobMemory of listStateStoreJobMemories(access)) {
    const candidate = jobMemory.promotionCandidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      continue;
    }
    if (candidate.status !== "pending") {
      return candidate;
    }

    const updatedCandidate: JobMemoryPromotionCandidateView = {
      ...candidate,
      status: accepted ? "accepted" : "rejected",
      updatedAt: now,
      resolvedAt: now
    };
    const nextMemory: JobMemoryView = {
      ...jobMemory,
      promotionCandidates: jobMemory.promotionCandidates.map((entry) => (entry.id === candidateId ? updatedCandidate : entry)),
      updatedAt: now
    };
    const thread = access.threads.get(jobMemory.threadId);
    if (thread) {
      thread.jobMemory = nextMemory;
      thread.updatedAt = Math.max(thread.updatedAt, now);
    }
    access.persistedJobMemoriesByThreadId.set(jobMemory.threadId, cloneJobMemory(nextMemory));

    if (accepted) {
      const projectMemory = getOrCreateProjectMemory(access, updatedCandidate.projectId, updatedCandidate.projectLabel);
      const nextProjectEntry: ProjectMemoryEntryView = {
        id: crypto.randomUUID(),
        sourceThreadId: jobMemory.threadId,
        kind: updatedCandidate.kind,
        summary: updatedCandidate.summary,
        details: updatedCandidate.details,
        acceptedAt: now
      };
      const nextProjectMemory: ProjectMemoryView = {
        ...projectMemory,
        summary: updatedCandidate.summary,
        entries: [...projectMemory.entries, nextProjectEntry].slice(-60),
        updatedAt: now
      };
      access.persistedProjectMemoriesByProjectId.set(updatedCandidate.projectId, nextProjectMemory);
    }

    if (thread) {
      access.refreshDerivedThreadState(thread, now);
    }
    queueStateStoreSave(access);
    emitStateStoreChange(access);
    return updatedCandidate;
  }

  return null;
}
