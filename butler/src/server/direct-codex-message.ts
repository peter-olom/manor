import { promises as fs } from "node:fs";
import path from "node:path";

import { extractOperatorCallbackThreadId, normalizeOperatorMessages, upsertOperatorMessage } from "./butler-operator-messages.js";
import { runSerializedCallbackReplacement } from "./butler-job-mutation-guard.js";
import type { JobPayloadKind } from "./job-instruction-artifacts.js";
import type { JobPayloadView } from "./job-payload-types.js";
import type { ButlerStateStore } from "./state-store.js";
import type { ButlerMessageView, ButlerNextWorkerReportAction, ButlerReviewScopeDisposition, CodexThreadExecutionContractView, SupervisionChecklistView } from "./types.js";
import { workerMessageDispatchMayHaveBeenAccepted } from "./worker-client-router.js";

export type DirectCodexMessagePingInput = {
  text: string;
  operatorRequestText?: string | null;
  imageReferenceIds?: string[];
  fileReferenceIds?: string[];
  inputItems?: unknown[];
  requestedAt?: number;
  callbackAlreadyRegistered?: boolean;
  nextWorkerReportAction?: ButlerNextWorkerReportAction;
  scopeDisposition: ButlerReviewScopeDisposition;
};

type DirectMessageReviewScope = {
  executionContract: CodexThreadExecutionContractView | null;
  supervisionChecklist: SupervisionChecklistView | null;
};

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparableChecklist(checklist: SupervisionChecklistView | null | undefined): unknown {
  return checklist
    ? { ...checklist, updatedAt: 0, heartbeat: { ...checklist.heartbeat, lastThreadEventAt: null } }
    : null;
}

export function planDirectMessageRollback(input: {
  currentPayload: JobPayloadView | null;
  originalPayload: JobPayloadView | null;
  payloadReplacement: JobPayloadView | null;
  currentScope: DirectMessageReviewScope;
  scopeReplacement: DirectMessageReviewScope | null;
}): { payload: boolean; scope: boolean } {
  const hasPayloadReplacement = input.payloadReplacement !== null;
  const hasScopeReplacement = input.scopeReplacement !== null;
  const ownsPayload = !hasPayloadReplacement || sameValue(input.currentPayload, input.payloadReplacement) || sameValue(input.currentPayload, input.originalPayload);
  const ownsScope = !hasScopeReplacement || (
    sameValue(input.currentScope.executionContract, input.scopeReplacement?.executionContract ?? null) &&
    sameValue(comparableChecklist(input.currentScope.supervisionChecklist), comparableChecklist(input.scopeReplacement?.supervisionChecklist))
  );
  const ownsReplacementGeneration = ownsPayload && ownsScope;
  return {
    payload: hasPayloadReplacement && ownsReplacementGeneration,
    scope: hasScopeReplacement && ownsReplacementGeneration
  };
}

export async function settleFailedDirectWorkerDispatch(
  error: unknown,
  preserve: () => Promise<void>,
  rollback: () => Promise<void>
): Promise<void> {
  try {
    await (workerMessageDispatchMayHaveBeenAccepted(error) ? preserve() : rollback());
  } catch (settlementError) {
    if (error instanceof Error) {
      if (error.cause === undefined) error.cause = settlementError;
      throw error;
    }
    throw new Error(String(error), { cause: settlementError });
  }
}

export type DirectCodexMessageAccess = {
  store: ButlerStateStore;
  registerPendingChatCallback(
    threadId: string,
    options?: { privateSteerText?: string | null; operatorRequestText?: string | null; nextWorkerReportAction?: ButlerNextWorkerReportAction; requestedAt?: number | null; dispatchState?: "ready" | "reserving"; scopeDisposition?: ButlerReviewScopeDisposition; workSliceNodeId?: string | null }
  ): Promise<void>;
  createOrUpdateJobPayload?(input: {
    threadId: string;
    kind: JobPayloadKind;
    instruction: string;
    imageReferenceIds?: string[];
    fileReferenceIds?: string[];
    replaceOutputScope?: boolean;
    onPrepared?: (payload: JobPayloadView) => void;
  }): Promise<JobPayloadView>;
  bindPendingChatCallbackWorkSlice?(threadId: string, requestedAt: number, workSliceNodeId: string): Promise<void>;
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

function codexSessionThreadId(filePath: string): string | null {
  return filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]?.toLowerCase() ?? null;
}

function callbackTurnId(id: string): string | null {
  return id.match(/^callback(?:-fallback)?-[^:]+:(?:[^:]+:)?([^:]+)$/i)?.[1] ?? null;
}

function directCodexMessageText(record: Record<string, unknown>): string | null {
  if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
    return null;
  }

  const payload = record.payload as Record<string, unknown>;
  if (payload.type !== "user_message" || typeof payload.message !== "string") {
    return null;
  }

  const text = payload.message.trim();
  if (!text || isInternalButlerWorkerPrompt(text)) {
    return null;
  }

  return text;
}

function isInternalButlerWorkerPrompt(text: string): boolean {
  return [
    "I put the job details in Manor for this thread.",
    "I saved new context for this job.",
    "I updated the job details with the checklist items",
    "I added Manor guidance for this job.",
    "I updated the job details in Manor.",
    "I updated the job payload."
  ].some((phrase) => text.includes(phrase));
}

async function listCodexSessionFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listCodexSessionFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(filePath);
    }
  }
  return files;
}

function callbackThreadIds(messages: ButlerMessageView[]): Set<string> {
  const threadIds = new Set<string>();
  for (const message of messages) {
    const threadId = extractOperatorCallbackThreadId(message.id);
    if (threadId) {
      threadIds.add(threadId);
    }
  }
  return threadIds;
}

type DirectCodexTranscriptMessage = {
  id: string;
  text: string;
  at: number;
};

function taskStartedTurn(record: Record<string, unknown>): { turnId: string; at: number } | null {
  if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
    return null;
  }

  const payload = record.payload as Record<string, unknown>;
  if (payload.type !== "task_started" || typeof payload.turn_id !== "string") {
    return null;
  }

  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  const startedAt = typeof payload.started_at === "number" ? payload.started_at * 1000 : NaN;
  const at = Number.isFinite(timestamp) ? timestamp : startedAt;
  return Number.isFinite(at) ? { turnId: payload.turn_id, at } : null;
}

function closestTaskStartTurnId(taskStarts: { turnId: string; at: number }[], directAt: number): string | null {
  let closest: { turnId: string; distance: number } | null = null;
  for (const taskStart of taskStarts) {
    const distance = Math.abs(taskStart.at - directAt);
    if (distance > 10_000) {
      continue;
    }

    if (!closest || distance < closest.distance) {
      closest = { turnId: taskStart.turnId, distance };
    }
  }

  return closest?.turnId ?? null;
}

function mapTaskStartsToDirectMessages(
  taskStarts: { turnId: string; at: number }[],
  directMessages: DirectCodexTranscriptMessage[]
): Map<string, DirectCodexTranscriptMessage> {
  const anchorsByTurnId = new Map<string, DirectCodexTranscriptMessage>();
  for (const directMessage of directMessages) {
    const turnId = closestTaskStartTurnId(taskStarts, directMessage.at);
    if (turnId) {
      anchorsByTurnId.set(turnId, directMessage);
    }
  }

  const sortedDirectMessages = [...directMessages].sort((left, right) => left.at - right.at);
  for (const taskStart of taskStarts) {
    if (anchorsByTurnId.has(taskStart.turnId)) {
      continue;
    }

    const fallbackAnchor = sortedDirectMessages.filter((directMessage) => directMessage.at <= taskStart.at).at(-1);
    if (fallbackAnchor) {
      anchorsByTurnId.set(taskStart.turnId, fallbackAnchor);
    }
  }

  return anchorsByTurnId;
}

function alignCallbacksToTranscriptTurns(messages: ButlerMessageView[], anchorsByTurnId: Map<string, DirectCodexTranscriptMessage>): boolean {
  let changed = false;
  const offsetsByAnchor = new Map<string, number>();
  for (const message of messages) {
    const turnId = callbackTurnId(message.id);
    const anchor = turnId ? anchorsByTurnId.get(turnId) : null;
    if (!anchor) {
      continue;
    }

    const offset = (offsetsByAnchor.get(anchor.id) ?? 0) + 1;
    offsetsByAnchor.set(anchor.id, offset);
    const at = anchor.at + offset;
    if (message.at !== at) {
      message.at = at;
      changed = true;
    }
  }

  return changed;
}

export async function backfillDirectCodexMessagesFromSessionFiles(messages: ButlerMessageView[], codexHomeDir: string): Promise<boolean> {
  const threadIds = callbackThreadIds(messages);
  if (threadIds.size === 0) {
    return false;
  }

  const sessionRoot = path.join(codexHomeDir, "sessions");
  const files = await listCodexSessionFiles(sessionRoot);
  let changed = false;
  const anchorsByTurnId = new Map<string, DirectCodexTranscriptMessage>();
  for (const filePath of files) {
    const threadId = codexSessionThreadId(filePath);
    if (!threadId || !threadIds.has(threadId)) {
      continue;
    }

    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const taskStarts: { turnId: string; at: number }[] = [];
    const directMessages: DirectCodexTranscriptMessage[] = [];
    let sequence = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const taskStart = taskStartedTurn(parsed);
      if (taskStart) {
        taskStarts.push(taskStart);
        continue;
      }

      const text = directCodexMessageText(parsed);
      if (!text) {
        continue;
      }

      const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      const at = Number.isFinite(timestamp) ? timestamp : Date.now();
      const id = `operator-direct-${threadId}-${at}-${sequence++}`;
      directMessages.push({ id, text, at });
    }

    for (const [turnId, directMessage] of mapTaskStartsToDirectMessages(taskStarts, directMessages)) {
      anchorsByTurnId.set(turnId, directMessage);
    }
  }

  changed = alignCallbacksToTranscriptTurns(messages, anchorsByTurnId) || changed;
  return normalizeOperatorMessages(messages) || changed;
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

  const lead = text || "Operator sent a direct Worker message with attachments or selected context.";
  return `${lead}\n\nDirect-message context: ${contextParts.join(", ")}.`;
}

export async function notifyDirectCodexMessage(
  access: DirectCodexMessageAccess,
  input: DirectCodexMessagePingInput & { threadId: string },
  observer?: { onReviewScopeReplacement?: (replacement: { executionContract: CodexThreadExecutionContractView | null; supervisionChecklist: SupervisionChecklistView | null }) => void; onJobPayloadReplacement?: (payload: JobPayloadView) => void }
): Promise<{ executionContract: CodexThreadExecutionContractView | null; supervisionChecklist: SupervisionChecklistView | null } | null> {
  if (input.scopeDisposition !== "preserve" && input.scopeDisposition !== "replace") {
    throw new Error("Direct Worker messages require an explicit scopeDisposition of preserve or replace.");
  }
  if (!access.store.getThread(input.threadId)) {
    throw new Error(`Job ${input.threadId} is not available for Butler notification.`);
  }

  return runSerializedCallbackReplacement(input.threadId, async () => {
    const privateSteerText = buildDirectCodexMessagePingSummary(input);
    const requestedAt = typeof input.requestedAt === "number" && Number.isFinite(input.requestedAt) ? input.requestedAt : Date.now();
    const scopeDisposition = input.scopeDisposition;
    const refreshed = scopeDisposition === "replace"
      ? access.store.refreshCompletedSupervisionChecklistForFollowup(input.threadId, privateSteerText, { force: true })
      : null;
    const refreshedThread = refreshed ? access.store.getThread(input.threadId) : null;
    const reviewScopeReplacement = refreshed ? { executionContract: refreshedThread?.executionContract ? structuredClone(refreshedThread.executionContract) : null, supervisionChecklist: refreshedThread?.supervisionChecklist ? structuredClone(refreshedThread.supervisionChecklist) : null } : null;
    if (reviewScopeReplacement) observer?.onReviewScopeReplacement?.(reviewScopeReplacement);
    const payload = await access.createOrUpdateJobPayload?.({
      threadId: input.threadId,
      kind: "direct_message",
      instruction: privateSteerText,
      imageReferenceIds: input.imageReferenceIds,
      fileReferenceIds: input.fileReferenceIds,
      replaceOutputScope: scopeDisposition === "replace",
      onPrepared: observer?.onJobPayloadReplacement
    });
    if (payload && input.callbackAlreadyRegistered) {
      await access.bindPendingChatCallbackWorkSlice?.(input.threadId, requestedAt, payload.protocol.currentScopeId);
    }
    if (!input.callbackAlreadyRegistered) {
      await access.registerPendingChatCallback(input.threadId, {
        privateSteerText,
        operatorRequestText: input.operatorRequestText ?? input.text,
        nextWorkerReportAction: "review",
        requestedAt,
        scopeDisposition,
        workSliceNodeId: payload?.protocol.currentScopeId ?? null
      });
    }
    access.noteThreadFocus(input.threadId, "direct_worker_message");
    access.store.addEvent(input.threadId, "butler.direct_message.pinged", "Butler was pinged for an operator direct message to a Worker.");
    await access.saveCallbackState();
    access.emit("change");
    return reviewScopeReplacement;
  });
}
