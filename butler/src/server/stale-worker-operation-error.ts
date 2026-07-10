export class StaleWorkerOperationError extends Error {
  readonly code = "WORKER_OPERATION_STALE";

  constructor(threadId: string, cause?: unknown) {
    super(`Worker operation for ${threadId} was superseded before dispatch completed.`);
    this.name = "StaleWorkerOperationError";
    if (cause !== undefined) this.cause = cause;
  }
}
