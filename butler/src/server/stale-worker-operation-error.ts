export class StaleWorkerOperationError extends Error {
  readonly code = "WORKER_OPERATION_STALE";
  readonly dispatchMayHaveBeenAccepted: boolean;

  constructor(threadId: string, options: { cause?: unknown; dispatchMayHaveBeenAccepted?: boolean } = {}) {
    super(`Worker operation for ${threadId} was superseded before dispatch completed.`);
    this.name = "StaleWorkerOperationError";
    this.dispatchMayHaveBeenAccepted = options.dispatchMayHaveBeenAccepted === true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
