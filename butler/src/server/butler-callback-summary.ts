import type { PendingChatCallback } from "./butler-agent-helpers.js";
import type { ButlerStateStore } from "./state-store.js";

export function describePendingCallbacks(store: ButlerStateStore, callbacks: PendingChatCallback[]): string {
  const outstandingCallbacks = callbacks.filter((callback) => callback.owesOperatorReply && callback.callbackState !== "closed");
  if (outstandingCallbacks.length === 0) {
    return "Delegated callback state: none pending.";
  }

  const lines = outstandingCallbacks
    .map((callback) => {
      const thread = store.getThread(callback.threadId);
      const projectLabel = thread?.supervisor.projectLabel ?? "unknown";
      const status = callback.lastWorkerStatusSeen ?? thread?.status ?? "unknown";
      const workerReport = callback.lastTerminalReportAt !== null ? store.getWorkerReport(callback.threadId) : null;
      if (callback.callbackState === "missing_worker_callback") {
        return `- job ${callback.threadId} on ${projectLabel}: no worker callback received; latest known thread status is ${status}. Butler still owes one operator reply and may need to inspect the thread directly before replying.`;
      }
      if (callback.callbackState === "received_worker_callback" && workerReport) {
        const details = [workerReport.summary, workerReport.details].filter(Boolean).join(" | ");
        return `- job ${callback.threadId} on ${projectLabel}: worker callback received (${workerReport.status}). Butler still owes one operator reply. Latest report: ${details}`;
      }
      if (callback.watchdogProbeState === "busy") {
        const wait = callback.watchdogProtectedOperation ? ` Protected wait: ${callback.watchdogProtectedOperation}.` : "";
        return `- job ${callback.threadId} on ${projectLabel}: waiting on worker callback; a runtime health probe confirms the Worker is still busy.${wait}`;
      }
      if (callback.watchdogAttentionAt) {
        const reason = callback.watchdogAttentionReason ? ` Last stop attempt: ${callback.watchdogAttentionReason}` : "";
        return `- job ${callback.threadId} on ${projectLabel}: Worker runtime is unresponsive and could not be safely stopped; Manor is still monitoring it.${reason}`;
      }
      if (callback.watchdogProbeState === "unreachable" && (callback.watchdogProbeFailures ?? 0) > 0) {
        return `- job ${callback.threadId} on ${projectLabel}: waiting on worker callback; runtime health probe failures: ${callback.watchdogProbeFailures}. Manor is retrying before any intervention.`;
      }
      return `- job ${callback.threadId} on ${projectLabel}: waiting on worker callback; latest known thread status is ${status}.`;
    })
    .join("\n");

  return ["Delegated callback state:", lines].join("\n");
}
