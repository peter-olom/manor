import type { ProviderRuntimeIngestion } from "./provider-runtime-ingestion.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";

export function persistCodexTransportCloseFailures(input: {
  reason: string;
  activeTurns: Array<[threadId: string, turnId: string]>;
  ingestion: ProviderRuntimeIngestion;
  onError: (message: string) => void;
}): void {
  const detail = redactSensitiveText(input.reason || "Codex app-server connection closed").slice(0, 3000);
  const at = Date.now();
  let saveAfter = Promise.resolve();
  for (const [threadId, turnId] of input.activeTurns) {
    saveAfter = input.ingestion.ingest({
      id: `transport-error-${threadId}-${at}`,
      type: "runtime.error",
      harness: "codex",
      threadId,
      turnId,
      at,
      payload: { message: detail }
    });
    saveAfter = input.ingestion.ingest({
      id: `transport-close-${threadId}-${at}`,
      type: "turn.completed",
      harness: "codex",
      threadId,
      turnId,
      at,
      payload: { state: "interrupted", errorMessage: detail }
    });
    saveAfter = input.ingestion.ingest({
      id: `transport-idle-${threadId}-${at}`,
      type: "thread.state.changed",
      harness: "codex",
      threadId,
      at,
      payload: { state: "idle" }
    });
  }
  void saveAfter.catch((error) => {
    input.onError(redactSensitiveText(error instanceof Error ? error.message : String(error)));
  });
}
