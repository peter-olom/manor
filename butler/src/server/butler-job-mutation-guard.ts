import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { ActivityWatchdogService } from "./activity-watchdog.js";
import type { ButlerThinkingLevel } from "./types.js";

type CallbackReviewGuard = {
  threadId: string;
  isCurrent: () => boolean;
  modelProvider?: string;
  modelId?: string;
  reasoningLevel?: ButlerThinkingLevel;
};

const callbackReviewGuard = new AsyncLocalStorage<CallbackReviewGuard>();
type MutationOwner = { active: boolean; heldThreads: Set<string> };

const mutationLockContext = new AsyncLocalStorage<MutationOwner>();
const mutationTails = new Map<string, Promise<void>>();
const MUTATING_JOB_TOOLS = new Set([
  "review_acceptance_point",
  "review_acceptance_points",
  "disprove_review_finding",
  "flush_rejected_acceptance_points",
  "review_preview_proof",
  "request_self_improvement",
  "hold_job_context",
  "message_job",
  "stop_job",
  "reply_to_operator",
  "delete_job"
]);

function targetThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === "string" && record.threadId.trim()) return record.threadId.trim();
  if (typeof record.sourceThreadId === "string" && record.sourceThreadId.trim()) return record.sourceThreadId.trim();
  return null;
}

export function runWithCallbackReviewGuard<T>(guard: CallbackReviewGuard, run: () => Promise<T>): Promise<T> {
  return callbackReviewGuard.run(guard, run);
}

export function getCallbackReviewExecution(): Pick<CallbackReviewGuard, "modelProvider" | "modelId" | "reasoningLevel"> | null {
  const guard = callbackReviewGuard.getStore();
  return guard ? { modelProvider: guard.modelProvider, modelId: guard.modelId, reasoningLevel: guard.reasoningLevel } : null;
}

export function runOutsideJobMutationContext<T>(run: () => T): T {
  return mutationLockContext.exit(run);
}

export function assertCallbackReviewCurrent(threadId: string): void {
  const guard = callbackReviewGuard.getStore();
  if (!guard) return;
  if (guard.threadId !== threadId || !guard.isCurrent()) {
    throw new Error("This callback review was superseded by newer Butler context.");
  }
}

export function hasCurrentCallbackReviewGuard(threadId: string): boolean {
  const guard = callbackReviewGuard.getStore();
  return Boolean(guard && guard.threadId === threadId && guard.isCurrent());
}

export function monitorCallbackReviewCurrent(threadId: string, watchdogs?: ActivityWatchdogService): { promise: Promise<never>; dispose: () => void } | null {
  const guard = callbackReviewGuard.getStore();
  if (!guard) return null;
  if (!watchdogs) throw new Error("Activity watchdogs are required while monitoring callback review currency.");
  let registration: ReturnType<ActivityWatchdogService["register"]> | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    const check = () => {
      if (guard.threadId === threadId && guard.isCurrent()) return;
      registration?.unregister();
      registration = null;
      const error = new Error("This callback review was superseded by newer Butler context.");
      error.name = "CallbackReviewSupersededError";
      reject(error);
    };
    registration = watchdogs.register({
      id: `review-current:${threadId}:${crypto.randomUUID()}`,
      policy: "callback-review-currency",
      target: threadId,
      callback: check
    });
    check();
  });
  return {
    promise,
    dispose: () => {
      registration?.unregister();
      registration = null;
    }
  };
}

async function withMutationLock<T>(threadId: string, run: () => Promise<T>): Promise<T> {
  const inheritedOwner = mutationLockContext.getStore();
  if (inheritedOwner?.active && inheritedOwner.heldThreads.has(threadId)) return run();
  const previous = mutationTails.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => turn);
  mutationTails.set(threadId, tail);
  await previous.catch(() => {});
  const owner = inheritedOwner?.active ? inheritedOwner : { active: true, heldThreads: new Set<string>() };
  owner.heldThreads.add(threadId);
  try {
    return inheritedOwner?.active ? await run() : await mutationLockContext.run(owner, run);
  } finally {
    owner.heldThreads.delete(threadId);
    if (!inheritedOwner?.active) owner.active = false;
    release();
    if (mutationTails.get(threadId) === tail) mutationTails.delete(threadId);
  }
}

export function runSerializedJobMutation<T>(threadId: string, run: () => Promise<T>): Promise<T> {
  return withMutationLock(threadId, run);
}

export function runSerializedJobMutations<T>(threadIds: string[], run: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(threadIds.filter(Boolean))].sort();
  const acquire = (index: number): Promise<T> => index >= ordered.length
    ? run()
    : withMutationLock(ordered[index]!, () => acquire(index + 1));
  return acquire(0);
}

export function runSerializedCallbackReplacement<T>(threadId: string, run: () => Promise<T>): Promise<T> {
  return withMutationLock(threadId, async () => {
    assertCallbackReviewCurrent(threadId);
    return run();
  });
}

export async function runButlerJobMutationGuardedTool<T>(
  toolName: string,
  params: unknown,
  run: () => Promise<T>
): Promise<T> {
  const threadId = targetThreadId(params);
  if (!MUTATING_JOB_TOOLS.has(toolName)) return run();
  return withMutationLock(threadId ?? callbackReviewGuard.getStore()?.threadId ?? "__butler_global__", async () => {
    const guardedThreadId = threadId ?? callbackReviewGuard.getStore()?.threadId ?? null;
    if (guardedThreadId) assertCallbackReviewCurrent(guardedThreadId);
    return run();
  });
}
