import type { CodexThreadRecord } from "./types.js";

export function workerExecutionEndAt(thread: CodexThreadRecord): number {
  const latestTurn = thread.turns.at(-1);
  if (thread.status === "active" || (latestTurn && latestTurn.completedAt === null)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    thread.createdAt,
    thread.workerReport?.updatedAt ?? 0,
    latestTurn?.startedAt ?? 0,
    latestTurn?.completedAt ?? 0
  );
}
