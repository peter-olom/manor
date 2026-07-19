import path from "node:path";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { keepPendingOperatorPromptsBefore } from "./butler-agent-session.js";
import { keepOperatorMessagesBefore } from "./butler-agent-chat-hygiene.js";
import { keepButlerActivityBefore } from "./butler-activity.js";
import type { ButlerAgentSessionAccess } from "./butler-agent-tool-access.js";
import { summarizeUsage, usageSamplesFromPiEntries } from "./model-usage.js";
import type { WorkerSessionControlAction, WorkerSessionControls } from "../shared/worker-session-controls.js";

type SessionEntry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  message?: { timestamp?: number; createdAt?: unknown; at?: unknown };
};

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function entryTimestamp(entry: SessionEntry): number | null {
  return parseTimestamp(entry.message?.timestamp) ??
    parseTimestamp(entry.message?.createdAt) ??
    parseTimestamp(entry.message?.at) ??
    parseTimestamp(entry.timestamp);
}

function requireIdleSession(access: ButlerAgentSessionAccess, action: string): AgentSession {
  const session = access.session;
  if (!session) throw new Error("Butler agent is not ready.");
  if (!session.isIdle || session.isCompacting || access.pending || access.pendingChatCallbacks.size > 0) {
    throw new Error(`Wait for Butler and its active Worker follow-ups to finish before ${action}.`);
  }
  return session;
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function operatorForkTimestamp(
  access: ButlerAgentSessionAccess,
  forkPoints: Array<{ entryId: string; text: string }>,
  entryId: string,
  fallback: number | null
): number | null {
  const selectedIndex = forkPoints.findIndex((point) => point.entryId === entryId);
  if (selectedIndex < 0) return fallback;
  const normalized = normalizePromptText(forkPoints[selectedIndex]!.text);
  const occurrence = forkPoints.slice(0, selectedIndex + 1)
    .filter((point) => normalizePromptText(point.text) === normalized).length - 1;
  const matching = access.operatorMessages.filter((message) =>
    message.role === "user" && normalizePromptText(message.text) === normalized
  )[occurrence];
  return matching?.at ?? fallback;
}

export function getButlerSessionControls(access: ButlerAgentSessionAccess): WorkerSessionControls {
  const session = access.session;
  if (!session) {
    return {
      supported: false,
      runtime: "pi",
      busy: false,
      compacting: false,
      autoCompactionEnabled: true,
      pendingMessageCount: 0,
      manualCompaction: null,
      sessionName: null,
      stats: null,
      forkPoints: [],
      leafId: null
    };
  }
  const stats = session.getSessionStats();
  const pricingModels = access.modelRegistry?.getAvailable() ?? [];
  const usage = summarizeUsage(usageSamplesFromPiEntries(
    session.sessionManager.getEntries(),
    session.sessionId,
    pricingModels,
    (model) => Boolean(access.modelRegistry?.isUsingOAuth(model as never))
  ));
  return {
    supported: true,
    runtime: "pi",
    busy: !session.isIdle || access.pending || access.pendingChatCallbacks.size > 0,
    compacting: session.isCompacting,
    autoCompactionEnabled: session.autoCompactionEnabled,
    pendingMessageCount: session.pendingMessageCount,
    manualCompaction: null,
    sessionName: session.sessionName?.trim() || null,
    stats: {
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      totalMessages: stats.totalMessages,
      tokens: { ...stats.tokens },
      cost: usage.cost.total,
      usage,
      contextUsage: stats.contextUsage ? { ...stats.contextUsage } : null
    },
    forkPoints: session.getUserMessagesForForking().map((point) => ({ entryId: point.entryId, text: point.text })),
    leafId: (session.sessionManager.getBranch() as SessionEntry[]).at(-1)?.id ?? null
  };
}

export async function compactButlerSession(access: ButlerAgentSessionAccess, instructions: string): Promise<void> {
  const session = requireIdleSession(access, "compacting the session");
  await session.compact(instructions.trim() || undefined);
  access.emit("change");
}

export function abortButlerRetry(access: ButlerAgentSessionAccess): void {
  const session = access.session;
  if (!session) throw new Error("Butler agent is not ready.");
  session.abortRetry();
}

export function renameButlerSession(access: ButlerAgentSessionAccess, name: string): void {
  const session = requireIdleSession(access, "renaming the session");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Session name is required.");
  session.setSessionName(trimmed.slice(0, 120));
  access.emit("change");
}

export async function exportButlerSession(access: ButlerAgentSessionAccess): Promise<string> {
  const session = access.session;
  if (!session) throw new Error("Butler agent is not ready.");
  const outputPath = path.join(access.sessionDir, `export-${Date.now()}.html`);
  const exported = path.resolve(await session.exportToHtml(outputPath));
  const allowedRoot = path.resolve(access.sessionDir);
  if (exported !== allowedRoot && !exported.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error("Pi returned an export outside the Butler session directory.");
  }
  return exported;
}

async function persistBranchState(access: ButlerAgentSessionAccess, targetAt: number | null): Promise<void> {
  if (targetAt !== null) {
    keepOperatorMessagesBefore(access.operatorMessages, targetAt);
    keepPendingOperatorPromptsBefore(access, targetAt);
    keepButlerActivityBefore(access, targetAt);
    access.traceBuffer.reset();
  }
  await Promise.all([access.saveOperatorMessageState(), access.saveActivitySummaryState()]);
  access.lastError = null;
  access.emit("change");
}

export async function forkButlerSession(access: ButlerAgentSessionAccess, entryId: string): Promise<void> {
  const session = requireIdleSession(access, "forking the session");
  const forkPoints = session.getUserMessagesForForking();
  const forkPoint = forkPoints.find((point) => point.entryId === entryId);
  if (!forkPoint) throw new Error("The selected branch point is no longer available.");
  const entry = (session.sessionManager.getBranch() as SessionEntry[]).find((candidate) => candidate.id === entryId);
  if (!entry || entry.type !== "message") throw new Error("The selected branch point is no longer available.");
  if (!entry.parentId) throw new Error("That first message cannot be used as a Butler branch point.");
  const targetAt = operatorForkTimestamp(access, forkPoints, entryId, entryTimestamp(entry));
  if (!session.sessionManager.createBranchedSession(entry.parentId)) throw new Error("Pi could not create the Butler session fork.");
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  await persistBranchState(access, targetAt);
}

export async function cloneButlerSession(access: ButlerAgentSessionAccess): Promise<void> {
  const session = requireIdleSession(access, "cloning the session");
  const leafId = (session.sessionManager.getBranch() as SessionEntry[]).at(-1)?.id;
  if (!leafId) throw new Error("There is no Butler session history to clone.");
  if (!session.sessionManager.createBranchedSession(leafId)) throw new Error("Pi could not clone the Butler session.");
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  await persistBranchState(access, null);
}

export async function runButlerSessionAction(
  access: ButlerAgentSessionAccess,
  action: WorkerSessionControlAction,
  input: { instructions?: string; entryId?: string; name?: string }
): Promise<void> {
  if (action === "compact") return compactButlerSession(access, input.instructions ?? "");
  if (action === "abort-retry") return abortButlerRetry(access);
  if (action === "fork") return forkButlerSession(access, input.entryId ?? "");
  if (action === "clone") return cloneButlerSession(access);
  return renameButlerSession(access, input.name ?? "");
}
