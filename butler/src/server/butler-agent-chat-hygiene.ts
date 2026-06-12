import type { AgentSession } from "@mariozechner/pi-coding-agent";

import type { ButlerMessageView } from "./types.js";

type SessionEntryLike = {
  id: string;
  type: string;
  timestamp?: string;
  firstKeptEntryId?: string;
  message?: {
    role?: string;
    timestamp?: number;
    createdAt?: unknown;
    at?: unknown;
  };
};

export type ButlerChatDeletePoint = {
  messageId: string;
  targetAt: number | null;
  previousEntryId: string | null;
};

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function appendsContextMessage(entry: SessionEntryLike): boolean {
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function getContextEntryAt(branch: SessionEntryLike[], messageIndex: number): SessionEntryLike | null {
  let compaction: SessionEntryLike | null = null;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      compaction = entry;
      break;
    }
  }
  const entries: SessionEntryLike[] = [];

  if (compaction) {
    entries.push(compaction);
    const compactionIndex = branch.findIndex((entry) => entry.id === compaction.id);
    let foundFirstKept = false;
    for (let index = 0; index < compactionIndex; index += 1) {
      const entry = branch[index];
      if (!entry) {
        continue;
      }
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept && appendsContextMessage(entry)) {
        entries.push(entry);
      }
    }
    for (let index = compactionIndex + 1; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry && appendsContextMessage(entry)) {
        entries.push(entry);
      }
    }
  } else {
    entries.push(...branch.filter(appendsContextMessage));
  }

  return entries[messageIndex] ?? null;
}

export function clearButlerSessionChat(session: AgentSession | null): void {
  if (!session) {
    return;
  }

  session.sessionManager.newSession();
  const manager = session.sessionManager as unknown as { _rewriteFile?: () => void };
  manager._rewriteFile?.();
  session.agent.state.messages = [];
}

export function locateButlerSessionDeletePoint(session: AgentSession | null, messageId: string): ButlerChatDeletePoint {
  if (!session) {
    throw new Error("Butler agent is not ready");
  }

  const match = /^message-(\d+)$/.exec(messageId);
  if (!match) {
    throw new Error("Only Butler prompt messages can be deleted.");
  }

  const messageIndex = Number.parseInt(match[1], 10);
  const targetMessage = session.messages[messageIndex] as { role?: string; timestamp?: unknown; createdAt?: unknown; at?: unknown } | undefined;
  if (!targetMessage || typeof targetMessage.role !== "string" || !targetMessage.role.startsWith("user")) {
    throw new Error("Only operator messages can be used as a delete point.");
  }

  const branch = session.sessionManager.getBranch() as SessionEntryLike[];
  const targetEntry = getContextEntryAt(branch, messageIndex);
  if (!targetEntry || targetEntry.type !== "message") {
    throw new Error("Could not locate that message in Butler history.");
  }

  const targetEntryIndex = branch.findIndex((entry) => entry.id === targetEntry.id);
  const previousEntry = targetEntryIndex > 0 ? branch[targetEntryIndex - 1] : null;
  const targetAt =
    parseTimestamp(targetMessage.timestamp) ??
    parseTimestamp(targetMessage.createdAt) ??
    parseTimestamp(targetMessage.at) ??
    parseTimestamp(targetEntry.timestamp);

  return {
    messageId,
    targetAt,
    previousEntryId: previousEntry?.id ?? null
  };
}

export function deleteButlerSessionChatFromLocated(session: AgentSession | null, deletePoint: ButlerChatDeletePoint): number | null {
  if (!session) {
    throw new Error("Butler agent is not ready");
  }

  if (deletePoint.previousEntryId) {
    session.sessionManager.createBranchedSession(deletePoint.previousEntryId);
  } else {
    clearButlerSessionChat(session);
  }

  const nextContext = session.sessionManager.buildSessionContext();
  session.agent.state.messages = nextContext.messages;
  return deletePoint.targetAt;
}

export function deleteButlerSessionChatFrom(session: AgentSession | null, messageId: string): number | null {
  return deleteButlerSessionChatFromLocated(session, locateButlerSessionDeletePoint(session, messageId));
}

export function keepOperatorMessagesBefore(messages: ButlerMessageView[], timestamp: number | null): void {
  if (timestamp === null) {
    return;
  }

  const deleteAfter = timestamp - 1;
  messages.splice(0, messages.length, ...messages.filter((entry) => (entry.at ?? 0) < deleteAfter));
}
