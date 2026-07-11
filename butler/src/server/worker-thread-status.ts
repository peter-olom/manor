import type { CodexThreadRecord } from "./types.js";

export function workerThreadIsRunning(thread: CodexThreadRecord | null | undefined): boolean {
  const turnStatus = thread?.turns.at(-1)?.status;
  return thread?.status === "active" || turnStatus === "inProgress" || turnStatus === "in_progress" || turnStatus === "started";
}
