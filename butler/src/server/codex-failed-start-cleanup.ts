type FailedStartCleanupOptions = {
  revokeCapability: (() => Promise<void>) | null;
  restoreCapability: (() => Promise<void>) | null;
  markDeleted: () => void;
  restoreDeleted: () => void;
  removeThreadDurably: () => Promise<boolean>;
  flushState: () => Promise<void>;
  clearOperationState: () => void;
  unsubscribe: () => Promise<void>;
  emitChange: () => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attemptRollback(action: (() => Promise<void>) | null): Promise<unknown | null> {
  if (!action) return null;
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

function cleanupError(primary: unknown, rollbackErrors: unknown[], stage: string): unknown {
  if (rollbackErrors.length === 0) return primary;
  const rollbackMessage = rollbackErrors.map(errorMessage).join("; ");
  return new AggregateError([primary, ...rollbackErrors], `${stage}: ${errorMessage(primary)}; rollback failed: ${rollbackMessage}`);
}

export async function cleanupFailedCodexStart(options: FailedStartCleanupOptions): Promise<void> {
  let capabilityRevoked = false;
  if (options.revokeCapability) {
    try {
      await options.revokeCapability();
      capabilityRevoked = true;
    } catch (error) {
      const restoreError = await attemptRollback(options.restoreCapability);
      throw cleanupError(error, restoreError ? [restoreError] : [], "Codex capability revocation failed");
    }
  }

  options.markDeleted();
  try {
    const removed = await options.removeThreadDurably();
    if (!removed) await options.flushState();
  } catch (error) {
    options.restoreDeleted();
    const rollbackErrors: unknown[] = [];
    const stateRestoreError = await attemptRollback(options.flushState);
    if (stateRestoreError) rollbackErrors.push(stateRestoreError);
    if (capabilityRevoked) {
      const capabilityRestoreError = await attemptRollback(options.restoreCapability);
      if (capabilityRestoreError) rollbackErrors.push(capabilityRestoreError);
    }
    throw cleanupError(error, rollbackErrors, "Codex durable start cleanup failed");
  }

  options.clearOperationState();
  await options.unsubscribe();
  options.emitChange();
}

export async function rejectFailedCodexStart(startError: unknown, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [startError, cleanupFailure],
      `Codex Worker start failed: ${errorMessage(startError)}; cleanup failed: ${errorMessage(cleanupFailure)}`
    );
  }
  throw startError;
}
