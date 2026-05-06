import type { ButlerStateStore } from "./state-store.js";
import type { ButlerNextWorkerReportAction } from "./types.js";

export type DirectCodexMessagePingInput = {
  text: string;
  imageReferenceIds?: string[];
  fileReferenceIds?: string[];
  inputItems?: unknown[];
};

export type DirectCodexMessageAccess = {
  store: ButlerStateStore;
  registerPendingChatCallback(
    threadId: string,
    options?: { privateSteerText?: string | null; nextWorkerReportAction?: ButlerNextWorkerReportAction }
  ): void;
  noteThreadFocus(threadId: string, reason?: string): void;
  saveCallbackState(): Promise<void>;
  emit(event: "change"): boolean;
};

function countStringIds(value: string[] | undefined): number {
  return (value ?? []).filter((entry) => entry.trim().length > 0).length;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildDirectCodexMessagePingSummary(input: DirectCodexMessagePingInput): string {
  const text = input.text.trim();
  const imageCount = countStringIds(input.imageReferenceIds);
  const fileCount = countStringIds(input.fileReferenceIds);
  const contextCount = Array.isArray(input.inputItems) ? input.inputItems.length : 0;
  const contextParts = [
    imageCount > 0 ? pluralize(imageCount, "image reference", "image references") : null,
    fileCount > 0 ? pluralize(fileCount, "file reference", "file references") : null,
    contextCount > 0 ? pluralize(contextCount, "selected context item", "selected context items") : null
  ].filter((entry): entry is string => Boolean(entry));

  if (text && contextParts.length === 0) {
    return text;
  }

  const lead = text || "Operator sent a direct Codex message with attachments or selected context.";
  return `${lead}\n\nDirect-message context: ${contextParts.join(", ")}.`;
}

export async function notifyDirectCodexMessage(
  access: DirectCodexMessageAccess,
  input: DirectCodexMessagePingInput & { threadId: string }
): Promise<void> {
  if (!access.store.getThread(input.threadId)) {
    throw new Error(`Job ${input.threadId} is not available for Butler notification.`);
  }

  const privateSteerText = buildDirectCodexMessagePingSummary(input);
  access.store.refreshCompletedSupervisionChecklistForFollowup(input.threadId, privateSteerText);
  access.registerPendingChatCallback(input.threadId, {
    privateSteerText,
    nextWorkerReportAction: "review"
  });
  access.noteThreadFocus(input.threadId, "direct_codex_message");
  access.store.addEvent(input.threadId, "butler.direct_message.pinged", "Butler was pinged for an operator direct message to Codex.");
  await access.saveCallbackState();
  access.emit("change");
}
