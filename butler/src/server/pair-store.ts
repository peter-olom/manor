import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { readJsonStateFile, writeJsonStateFileAtomic } from "./json-state-file.js";
import type { ButlerStateStore } from "./state-store.js";
import { workerThreadIsRunning } from "./worker-thread-status.js";
import type { PairAutomation, PairAutomationOutcome, PairChat, PairMessage, PairStatus, PairSummary, PairWorker, PairWorkerHandoff } from "../shared/pairing.js";
import { createIntervalSchedule, dailyScheduledSlotAt, nextAutomationRunAt, nextDailyRunAfterLastRun, normalizeDailyTimes, normalizeStoredAutomation, withAutomationLabels } from "./session-automation.js";
import { resolveOperatorTimezone } from "./operator-timezone.js";

type LegacyPairFields = { codexModel?: string | null; codexEffort?: string | null };
type PersistedPairState = {
  pairs: Array<PairChat & LegacyPairFields>;
  lastUsedCompose?: LastUsedCompose | null;
  workerAffinity?: WorkerProviderAffinity | null;
};

export type WorkerProviderAffinity = {
  hasSuccessfulDelegation: boolean;
  lastProvider: string | null;
  lastHarness?: string | null;
  modelByProvider: Record<string, string>;
  effortByProvider: Record<string, string | null>;
  modelByRoute?: Record<string, string>;
  effortByRoute?: Record<string, string | null>;
  updatedAt: number | null;
};

export type LastUsedCompose = {
  butlerModel?: string | null;
  butlerThinkingLevel?: string | null;
  workerHarness?: string | null;
  workerModel?: string | null;
  workerEffort?: string | null;
  updatedAt?: number | null;
};

type PairSnapshotInput = {
  butlerSessionId?: string | null;
  butlerReady?: boolean;
  butlerPending?: boolean;
  butlerPendingReason?: string | null;
  butlerLastError?: string | null;
  messageCount?: number;
  lastMessage?: PairMessage | null;
  updatedAt?: number;
  butlerThinkingLevel?: string | null;
  butlerModel?: string | null;
  workerHarness?: string | null;
  workerModel?: string | null;
  workerEffort?: string | null;
};

type PairComposeOverrideInput = {
  butlerThinkingLevel?: string | null;
  butlerModel?: string | null;
  workerHarness?: string | null;
  workerModel?: string | null;
  workerEffort?: string | null;
};

const DEFAULT_TITLE = "New session";

function normalizeLastUsedCompose(raw: LastUsedCompose | null | undefined): LastUsedCompose | null {
  if (!raw) return null;
  const butlerModel = typeof raw.butlerModel === "string" && raw.butlerModel.trim() ? raw.butlerModel : null;
  const butlerThinkingLevel = typeof raw.butlerThinkingLevel === "string" && raw.butlerThinkingLevel.trim() ? raw.butlerThinkingLevel : null;
  const workerHarness = typeof raw.workerHarness === "string" && raw.workerHarness.trim() ? raw.workerHarness.trim() : null;
  const workerModel = typeof raw.workerModel === "string" && raw.workerModel.trim() ? raw.workerModel : null;
  const workerEffort = typeof raw.workerEffort === "string" && raw.workerEffort.trim() ? raw.workerEffort : null;
  if (!butlerModel && !butlerThinkingLevel && !workerHarness && !workerModel && !workerEffort) return null;
  return {
    butlerModel,
    butlerThinkingLevel,
    workerHarness,
    workerModel,
    workerEffort,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
  };
}

function normalizeWorkerAffinity(raw: WorkerProviderAffinity | null | undefined): WorkerProviderAffinity | null {
  if (!raw || raw.hasSuccessfulDelegation !== true) return null;
  const lastProvider = typeof raw.lastProvider === "string" && raw.lastProvider.trim() ? raw.lastProvider.trim() : null;
  const modelByProvider = Object.fromEntries(
    Object.entries(raw.modelByProvider ?? {}).filter(([provider, model]) => provider.trim() && typeof model === "string" && model.trim())
  );
  if (!lastProvider || !modelByProvider[lastProvider]) return null;
  const effortByProvider = Object.fromEntries(
    Object.entries(raw.effortByProvider ?? {}).filter(([provider, effort]) =>
      provider.trim() && (effort === null || (typeof effort === "string" && effort.trim()))
    )
  ) as Record<string, string | null>;
  const lastHarness = typeof raw.lastHarness === "string" && raw.lastHarness.trim() ? raw.lastHarness.trim() : null;
  const modelByRoute = Object.fromEntries(
    Object.entries(raw.modelByRoute ?? {}).filter(([route, model]) => route.trim() && typeof model === "string" && model.trim())
  );
  const effortByRoute = Object.fromEntries(
    Object.entries(raw.effortByRoute ?? {}).filter(([route, effort]) =>
      route.trim() && (effort === null || (typeof effort === "string" && effort.trim()))
    )
  ) as Record<string, string | null>;
  return {
    hasSuccessfulDelegation: true,
    lastProvider,
    lastHarness,
    modelByProvider,
    effortByProvider,
    modelByRoute,
    effortByRoute,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
  };
}

function migratedWorkerAffinity(lastUsed: LastUsedCompose | null): WorkerProviderAffinity | null {
  const model = lastUsed?.workerModel?.trim();
  if (!model) return null;
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "openai-codex";
  const harness = lastUsed?.workerHarness?.trim() || (slash > 0 ? "pi" : "codex");
  const route = workerAffinityRouteKey(harness, provider);
  return {
    hasSuccessfulDelegation: true,
    lastProvider: provider,
    lastHarness: harness,
    modelByProvider: { [provider]: model },
    effortByProvider: { [provider]: lastUsed?.workerEffort?.trim() || null },
    modelByRoute: { [route]: model },
    effortByRoute: { [route]: lastUsed?.workerEffort?.trim() || null },
    updatedAt: lastUsed?.updatedAt ?? null
  };
}

export function workerAffinityRouteKey(harness: string, provider: string): string {
  return `${harness.trim()}\u001f${provider.trim()}`;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeWorkerRuntime(value: unknown, threadId: string, source?: string | null): "openai" | "pi-rpc" | null {
  if (value === "pi-rpc" || value === "openai") return value;
  if (source === "pi-rpc" || threadId.startsWith("pi-")) return "pi-rpc";
  if (source === "appServer" || source === "cli" || source === "vscode") return "openai";
  return null;
}

function normalizeWorkerHarness(value: unknown, runtime: "openai" | "pi-rpc" | null): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  if (runtime === "pi-rpc") return "pi";
  if (runtime === "openai") return "codex";
  return null;
}

function cloneWorkerHandoff(handoff: PairWorkerHandoff | null | undefined): PairWorkerHandoff | null {
  if (!handoff) return null;
  const predecessor = cloneWorkerHandoff(handoff.handedOffFrom);
  return {
    threadId: handoff.threadId,
    runtime: handoff.runtime,
    harness: handoff.harness,
    provider: handoff.provider,
    model: handoff.model,
    ...(predecessor ? { handedOffFrom: predecessor } : {})
  };
}

function normalizeWorkerHandoff(raw: PairWorkerHandoff | null | undefined): PairWorkerHandoff | null {
  if (!raw || typeof raw.threadId !== "string" || !raw.threadId.trim()) return null;
  const runtime = raw.runtime === "openai" || raw.runtime === "pi-rpc" ? raw.runtime : null;
  const predecessor = normalizeWorkerHandoff(raw.handedOffFrom);
  return {
    threadId: raw.threadId.trim(),
    runtime,
    harness: normalizeWorkerHarness(raw.harness, runtime),
    provider: normalizeText(raw.provider) || null,
    model: normalizeText(raw.model) || null,
    ...(predecessor ? { handedOffFrom: predecessor } : {})
  };
}

function clonePairWorker(worker: PairWorker | null): PairWorker | null {
  return worker ? {
    ...worker,
    handedOffFrom: cloneWorkerHandoff(worker.handedOffFrom)
  } : null;
}

function cloneAutomation(automation: PairAutomation | null, timezone: string): PairAutomation | null {
  return automation ? withAutomationLabels({
    ...automation,
    schedule: automation.schedule.kind === "daily" ? { kind: "daily", times: [...automation.schedule.times] } : { ...automation.schedule },
    running: automation.running ? { ...automation.running } : null,
    lastRun: automation.lastRun ? { ...automation.lastRun } : null
  }, Date.now(), timezone) : null;
}

function scheduledSlotFor(automation: Pick<PairAutomation, "schedule">, nextRunAt: number | null, timezone: string): string | null {
  return automation.schedule.kind === "daily" && nextRunAt !== null
    ? dailyScheduledSlotAt(automation.schedule.times, nextRunAt, timezone)
    : null;
}

function titleFromText(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "Untitled Butler session";
  }
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

export function pairTitleIsDefault(title: string | null | undefined): boolean {
  return titleFromText(title ?? DEFAULT_TITLE) === DEFAULT_TITLE;
}

function reportCloseoutMessageId(threadId: string, turnId: string): string {
  return `callback-${threadId}:${turnId}`;
}

function reviewedReportUpdatedAt(pair: PairChat, store: ButlerStateStore, message: PairMessage | null | undefined): number | null {
  if (!pair.worker || !message || message.role !== "butler") {
    return null;
  }
  const report = store.getWorkerReport(pair.worker.threadId);
  if (!report || report.status !== "completed") {
    return null;
  }
  return message.id === reportCloseoutMessageId(report.threadId, report.turnId) ? report.updatedAt : null;
}

function emptyPair(input: { id: string; title?: string | null; defaultCwd?: string | null; now: number }): PairChat {
  return {
    id: input.id,
    title: titleFromText(input.title ?? DEFAULT_TITLE),
    status: "idle",
    projectId: null,
    projectLabel: null,
    createdAt: input.now,
    updatedAt: input.now,
    defaultCwd: normalizeText(input.defaultCwd) || null,
    automation: null,
    butlerSessionId: input.id,
    butlerReady: false,
    butlerPending: false,
    butlerPendingReason: null,
    butlerLastError: null,
    worker: null,
    memoryQuery: null,
    lastHandoffPrompt: null,
    messageCount: 0,
    lastMessage: null,
    butlerThinkingLevel: null,
    butlerModel: null,
    workerHarness: null,
    workerModel: null,
    workerEffort: null
  };
}

function normalizePair(raw: Partial<PairChat> & LegacyPairFields & { id?: string }, store: ButlerStateStore): PairChat | null {
  if (!raw.id) {
    return null;
  }
  const now = Date.now();
  const pair = emptyPair({
    id: raw.id,
    title: raw.title ?? DEFAULT_TITLE,
    defaultCwd: raw.defaultCwd,
    now: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now
  });
  pair.status = raw.status === "butler_running" || raw.status === "worker_running" || raw.status === "needs_butler_review" || raw.status === "blocked" ? raw.status : "idle";
  pair.projectId = typeof raw.projectId === "string" ? raw.projectId : null;
  pair.projectLabel = typeof raw.projectLabel === "string" ? raw.projectLabel : null;
  pair.updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : pair.createdAt;
  pair.automation = normalizeStoredAutomation(raw.automation, now, resolveOperatorTimezone());
  pair.butlerSessionId = typeof raw.butlerSessionId === "string" && raw.butlerSessionId.trim() ? raw.butlerSessionId : pair.id;
  pair.butlerReady = raw.butlerReady === true;
  pair.butlerPending = raw.butlerPending === true;
  pair.butlerPendingReason = typeof raw.butlerPendingReason === "string" && raw.butlerPendingReason.trim() ? raw.butlerPendingReason : null;
  pair.butlerLastError = typeof raw.butlerLastError === "string" && raw.butlerLastError.trim() ? raw.butlerLastError : null;
  const workerThread = raw.worker ? store.getThread(raw.worker.threadId) : null;
  const droppedMissingWorker = Boolean(raw.worker && !workerThread);
  const workerRuntime = raw.worker ? normalizeWorkerRuntime(raw.worker.runtime, raw.worker.threadId, workerThread?.source) : null;
  pair.worker = raw.worker && workerThread ? {
    ...raw.worker,
    runtime: workerRuntime,
    harness: normalizeWorkerHarness(raw.worker.harness, workerRuntime),
    provider: normalizeText(raw.worker.provider) || workerThread?.modelProvider || null,
    model: normalizeText(raw.worker.model) || null,
    requestedReasoningEffort: normalizeText(raw.worker.requestedReasoningEffort) || workerThread?.requestedReasoningEffort || null,
    handedOffFrom: normalizeWorkerHandoff(raw.worker.handedOffFrom),
    lastReviewedReportAt:
      typeof raw.worker.lastReviewedReportAt === "number" && Number.isFinite(raw.worker.lastReviewedReportAt)
        ? raw.worker.lastReviewedReportAt
        : null
  } : null;
  pair.memoryQuery = typeof raw.memoryQuery === "string" && raw.memoryQuery.trim() ? raw.memoryQuery : null;
  pair.lastHandoffPrompt = pair.worker && typeof raw.lastHandoffPrompt === "string" && raw.lastHandoffPrompt.trim() ? raw.lastHandoffPrompt : null;
  pair.messageCount = typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount) ? Math.max(0, Math.trunc(raw.messageCount)) : 0;
  pair.lastMessage = raw.lastMessage ?? null;
    pair.butlerThinkingLevel = typeof raw.butlerThinkingLevel === "string" && raw.butlerThinkingLevel.trim() ? raw.butlerThinkingLevel : null;
    pair.butlerModel = typeof raw.butlerModel === "string" && raw.butlerModel.trim() ? raw.butlerModel : null;
    const persistedWorkerModel = raw.workerModel ?? raw.codexModel;
    const persistedWorkerEffort = raw.workerEffort ?? raw.codexEffort;
    const legacyWorkerRuntime = typeof persistedWorkerModel === "string" && persistedWorkerModel.includes("/") ? "pi-rpc" : "openai";
    pair.workerHarness = !droppedMissingWorker && persistedWorkerModel
      ? normalizeWorkerHarness(raw.workerHarness ?? raw.worker?.harness, raw.worker?.runtime ?? legacyWorkerRuntime)
      : null;
    pair.workerModel = !droppedMissingWorker && typeof persistedWorkerModel === "string" && persistedWorkerModel.trim() ? persistedWorkerModel : null;
    pair.workerEffort = !droppedMissingWorker && typeof persistedWorkerEffort === "string" && persistedWorkerEffort.trim() ? persistedWorkerEffort : null;
  pair.status = deriveStatus(pair, store);
  return pair;
}

function deriveStatus(pair: PairChat, store: ButlerStateStore): PairStatus {
  if (pair.butlerPendingReason) {
    return "blocked";
  }
  if (pair.worker) {
    const report = store.getWorkerReport(pair.worker.threadId);
    const thread = store.getThread(pair.worker.threadId);
    if (report?.status === "blocked" && !workerThreadIsRunning(thread)) {
      return "blocked";
    }
    const reportNeedsReview =
      report &&
      (report.status === "completed" || !workerThreadIsRunning(thread)) &&
      (!pair.worker.lastRevertAt || report.updatedAt > pair.worker.lastRevertAt) &&
      (!pair.worker.lastReviewedReportAt || report.updatedAt > pair.worker.lastReviewedReportAt);
    if (reportNeedsReview) {
      return "needs_butler_review";
    }
    if (workerThreadIsRunning(thread) || pair.worker.status === "running" || pair.worker.status === "starting") {
      return "worker_running";
    }
  }
  return pair.butlerPending ? "butler_running" : "idle";
}

export class PairStore extends EventEmitter {
  private pairs = new Map<string, PairChat>();
  private lastUsedCompose: LastUsedCompose | null = null;
  private workerAffinity: WorkerProviderAffinity | null = null;
  private saveInFlight: Promise<void> | null = null;
  private saveQueued = false;

  constructor(
    private readonly statePath: string,
    private readonly store: ButlerStateStore
  ) {
    super();
  }

  async load(): Promise<void> {
    const loaded = await readJsonStateFile<PersistedPairState>(this.statePath, { pairs: [] });
    this.pairs.clear();
    for (const raw of loaded.pairs) {
      const pair = normalizePair(raw, this.store);
      if (pair) {
        this.pairs.set(pair.id, pair);
      }
    }
    this.lastUsedCompose = normalizeLastUsedCompose(loaded.lastUsedCompose);
    this.workerAffinity = normalizeWorkerAffinity(loaded.workerAffinity) ?? migratedWorkerAffinity(this.lastUsedCompose);
  }

  getLastUsedCompose(): LastUsedCompose | null {
    return this.lastUsedCompose ? { ...this.lastUsedCompose } : null;
  }

  getWorkerAffinity(): WorkerProviderAffinity | null {
    return this.workerAffinity ? {
      ...this.workerAffinity,
      modelByProvider: { ...this.workerAffinity.modelByProvider },
      effortByProvider: { ...this.workerAffinity.effortByProvider },
      modelByRoute: { ...this.workerAffinity.modelByRoute },
      effortByRoute: { ...this.workerAffinity.effortByRoute }
    } : null;
  }

  recordSuccessfulWorkerSelection(input: { harness: string; provider: string; model: string; effort?: string | null }): WorkerProviderAffinity {
    const harness = input.harness.trim();
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (!harness || !provider || !model) throw new Error("Worker harness, provider, and model are required");
    const now = Date.now();
    const route = workerAffinityRouteKey(harness, provider);
    this.workerAffinity = {
      hasSuccessfulDelegation: true,
      lastProvider: provider,
      lastHarness: harness,
      modelByProvider: { ...this.workerAffinity?.modelByProvider, [provider]: model },
      effortByProvider: { ...this.workerAffinity?.effortByProvider, [provider]: input.effort?.trim() || null },
      modelByRoute: { ...this.workerAffinity?.modelByRoute, [route]: model },
      effortByRoute: { ...this.workerAffinity?.effortByRoute, [route]: input.effort?.trim() || null },
      updatedAt: now
    };
    this.lastUsedCompose = normalizeLastUsedCompose({
      ...this.lastUsedCompose,
      workerHarness: harness,
      workerModel: model,
      workerEffort: input.effort?.trim() || null,
      updatedAt: now
    });
    this.queueSave();
    this.emit("change");
    return this.getWorkerAffinity()!;
  }

  listSummaries(): PairSummary[] {
    const timezone = resolveOperatorTimezone();
    return [...this.pairs.values()]
      .map((pair) => ({ ...pair, automation: cloneAutomation(pair.automation, timezone), status: deriveStatus(pair, this.store) }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getPair(pairId: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    return pair ? { ...pair, automation: cloneAutomation(pair.automation, resolveOperatorTimezone()), status: deriveStatus(pair, this.store) } : null;
  }

  configureAutomation(pairId: string, input: { instruction: string; dailyTimes: unknown }, now = Date.now()): PairChat | null {
    const dailyTimes = normalizeDailyTimes(input.dailyTimes);
    return this.configureAutomationSchedule(pairId, input.instruction, { kind: "daily", times: dailyTimes }, now);
  }

  configureIntervalAutomation(pairId: string, input: { instruction: string; everyMinutes: unknown; durationMinutes: unknown }, now = Date.now()): PairChat | null {
    return this.configureAutomationSchedule(pairId, input.instruction, createIntervalSchedule(input.everyMinutes, input.durationMinutes, now), now);
  }

  private configureAutomationSchedule(pairId: string, rawInstruction: string, schedule: PairAutomation["schedule"], now: number): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;
    const instruction = rawInstruction.trim();
    if (!instruction) throw new Error("Automation instructions are required");
    if (instruction.length > 20_000) throw new Error("Automation instructions must be 20,000 characters or fewer");
    const existing = pair.automation;
    if (existing?.running) throw new Error("Wait for the current automation run to finish before changing its schedule");
    const timezone = resolveOperatorTimezone();
    const nextRunAt = nextAutomationRunAt(schedule, now, timezone);
    pair.automation = withAutomationLabels({
      id: existing?.id ?? crypto.randomUUID(),
      instruction,
      schedule,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt,
      nextRunSlot: schedule.kind === "daily" && nextRunAt !== null ? dailyScheduledSlotAt(schedule.times, nextRunAt, timezone) : null,
      running: null,
      lastRun: existing?.lastRun ? { ...existing.lastRun } : null
    }, now, timezone);
    pair.updatedAt = now;
    this.queueSave();
    this.emit("change");
    return this.getPair(pairId);
  }

  setAutomationEnabled(pairId: string, enabled: boolean, now = Date.now()): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair?.automation) return null;
    if (pair.automation.enabled === enabled) return this.getPair(pairId);
    if (enabled && pair.automation.schedule.kind === "interval" && pair.automation.schedule.endsAt <= now) {
      throw new Error("This interval automation has completed. Edit it with Butler to schedule another run window");
    }
    pair.automation.enabled = enabled;
    pair.automation.updatedAt = now;
    const timezone = resolveOperatorTimezone();
    pair.automation.nextRunAt = enabled ? nextAutomationRunAt(pair.automation.schedule, now, timezone) : null;
    pair.automation.nextRunSlot = scheduledSlotFor(pair.automation, pair.automation.nextRunAt, timezone);
    pair.updatedAt = now;
    this.queueSave();
    this.emit("change");
    return this.getPair(pairId);
  }

  deleteAutomation(pairId: string, now = Date.now()): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;
    if (pair.automation) {
      pair.automation = null;
      pair.updatedAt = now;
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pairId);
  }

  restoreAutomation(pairId: string, automation: PairAutomation | null, updatedAt: number): boolean {
    const pair = this.pairs.get(pairId);
    if (!pair) return false;
    pair.automation = cloneAutomation(automation, resolveOperatorTimezone());
    pair.updatedAt = updatedAt;
    this.queueSave();
    this.emit("change");
    return true;
  }

  claimAutomationRun(pairId: string, automationId: string, now = Date.now()): PairAutomation["running"] | null {
    const pair = this.pairs.get(pairId);
    const automation = pair?.automation;
    if (!pair || !automation || automation.id !== automationId || !automation.enabled || automation.running || !automation.nextRunAt || automation.nextRunAt > now) return null;
    let scheduledFor = automation.nextRunAt;
    if (automation.schedule.kind === "interval" && scheduledFor < now) {
      const intervalMs = automation.schedule.everyMinutes * 60_000;
      const latestSlot = automation.schedule.startsAt + Math.floor((Math.min(now, automation.schedule.endsAt) - automation.schedule.startsAt) / intervalMs) * intervalMs;
      scheduledFor = Math.max(scheduledFor, latestSlot);
    }
    const timezone = resolveOperatorTimezone();
    const running = {
      id: crypto.randomUUID(),
      scheduledFor,
      startedAt: now,
      scheduledSlot: automation.schedule.kind === "daily"
        ? automation.nextRunSlot ?? dailyScheduledSlotAt(automation.schedule.times, scheduledFor, timezone)
        : null
    };
    automation.running = running;
    automation.nextRunAt = nextAutomationRunAt(automation.schedule, now, timezone);
    automation.nextRunSlot = scheduledSlotFor(automation, automation.nextRunAt, timezone);
    automation.updatedAt = now;
    pair.updatedAt = now;
    this.queueSave();
    this.emit("change");
    return { ...running };
  }

  finishAutomationRun(pairId: string, automationId: string, runId: string, input: {
    outcome: PairAutomationOutcome;
    summary: string;
    resultPath?: string | null;
  }, now = Date.now()): PairChat | null {
    const pair = this.pairs.get(pairId);
    const automation = pair?.automation;
    if (!pair || !automation || automation.id !== automationId || automation.running?.id !== runId) return pair ? this.getPair(pairId) : null;
    automation.lastRun = {
      ...automation.running,
      finishedAt: now,
      outcome: input.outcome,
      summary: normalizeText(input.summary) || input.outcome,
      resultPath: normalizeText(input.resultPath) || null
    };
    automation.running = null;
    automation.updatedAt = now;
    if (automation.enabled && automation.schedule.kind === "daily") {
      const timezone = resolveOperatorTimezone();
      automation.nextRunAt = nextDailyRunAfterLastRun(automation.schedule.times, now, timezone, {
        scheduledFor: automation.lastRun.scheduledFor,
        scheduledSlot: automation.lastRun.scheduledSlot ?? null
      });
      automation.nextRunSlot = dailyScheduledSlotAt(automation.schedule.times, automation.nextRunAt, timezone);
    } else if (automation.enabled && (!automation.nextRunAt || automation.nextRunAt <= now)) {
      const timezone = resolveOperatorTimezone();
      automation.nextRunAt = nextAutomationRunAt(automation.schedule, now, timezone);
      automation.nextRunSlot = scheduledSlotFor(automation, automation.nextRunAt, timezone);
    }
    pair.updatedAt = now;
    this.queueSave();
    this.emit("change");
    return this.getPair(pairId);
  }

  reconcileAutomationsAfterRestart(now = Date.now()): number {
    const timezone = resolveOperatorTimezone();
    let changed = 0;
    for (const pair of this.pairs.values()) {
      const automation = pair.automation;
      if (!automation) continue;
      let pairChanged = false;
      const interrupted = Boolean(automation.running);
      if (automation.running) {
        automation.lastRun = {
          ...automation.running,
          finishedAt: now,
          outcome: "skipped",
          summary: "Run was interrupted when Butler restarted.",
          resultPath: null
        };
        automation.running = null;
        changed += 1;
        pairChanged = true;
      }
      const intervalExpired = automation.schedule.kind === "interval" && automation.schedule.endsAt <= now;
      if (automation.enabled && automation.schedule.kind === "daily") {
        if (automation.nextRunAt && !interrupted) {
          if (automation.nextRunAt <= now) {
            automation.lastRun = {
              id: crypto.randomUUID(), scheduledFor: automation.nextRunAt, startedAt: now, finishedAt: now,
              outcome: "skipped", summary: "Missed while Butler was offline.", resultPath: null,
              scheduledSlot: automation.nextRunSlot ?? dailyScheduledSlotAt(automation.schedule.times, automation.nextRunAt, timezone)
            };
          }
        }
        const recomputed = nextDailyRunAfterLastRun(automation.schedule.times, now, timezone, automation.lastRun ? {
          scheduledFor: automation.lastRun.scheduledFor,
          scheduledSlot: automation.lastRun.scheduledSlot ?? null
        } : null);
        const recomputedSlot = dailyScheduledSlotAt(automation.schedule.times, recomputed, timezone);
        if (recomputed !== automation.nextRunAt || recomputedSlot !== automation.nextRunSlot) {
          automation.nextRunAt = recomputed;
          automation.nextRunSlot = recomputedSlot;
          changed += 1;
          pairChanged = true;
        }
      } else if (automation.enabled && (intervalExpired || automation.nextRunAt === null || automation.nextRunAt <= now)) {
        if (automation.nextRunAt && !interrupted) {
          automation.lastRun = {
            id: crypto.randomUUID(), scheduledFor: automation.nextRunAt, startedAt: now, finishedAt: now,
            outcome: "skipped", summary: "Missed while Butler was offline.", resultPath: null
          };
        }
        automation.nextRunAt = intervalExpired ? null : nextAutomationRunAt(automation.schedule, now, timezone);
        automation.nextRunSlot = null;
        changed += 1;
        pairChanged = true;
      } else if (!automation.enabled && (automation.nextRunAt !== null || automation.nextRunSlot != null)) {
        automation.nextRunAt = null;
        automation.nextRunSlot = null;
        changed += 1;
        pairChanged = true;
      }
      if (pairChanged) {
        automation.updatedAt = now;
        pair.updatedAt = now;
      }
    }
    if (changed > 0) {
      this.queueSave();
      this.emit("change");
    }
    return changed;
  }

  /**
   * Recomputes the stored `nextRunAt` for enabled, idle daily automations using
   * the current operator timezone. Called when the operator changes their
   * timezone in Settings so already-scheduled daily runs move to the new zone
   * without a restart (labels already update live via `resolveOperatorTimezone`).
   *
   * Interval automations are timezone-independent for scheduling and running
   * automations are left untouched so an in-flight dispatch is not disturbed.
   *
   * Edge cases:
   * - Duplicate same-day slots: slots up to the last configured slot that fired
   *   are skipped on the last run's new-zone calendar day. Remaining later slots
   *   still fire (e.g. ['09:00','17:00']: after 09:00 fires, 17:00 still runs today).
   * - Due-but-unfired run: an automation that is already overdue (`nextRunAt` <=
   *   now) is left untouched so the scheduler fires it now (catch-up); the next
   *   cycle then advances into the new zone, so the run is never silently dropped.
   */
  recomputeAutomationSchedules(now = Date.now()): number {
    const timezone = resolveOperatorTimezone();
    let changed = 0;
    for (const pair of this.pairs.values()) {
      const automation = pair.automation;
      if (!automation || !automation.enabled || automation.running || automation.schedule.kind !== "daily") continue;
      // Don't displace an already-overdue run: leave it so the scheduler fires it
      // now (catch-up); the next cycle advances into the new zone.
      if (automation.nextRunAt !== null && automation.nextRunAt <= now) continue;
      const recomputed = nextDailyRunAfterLastRun(automation.schedule.times, now, timezone, automation.lastRun ? { scheduledFor: automation.lastRun.scheduledFor, scheduledSlot: automation.lastRun.scheduledSlot ?? null } : null);
      const recomputedSlot = dailyScheduledSlotAt(automation.schedule.times, recomputed, timezone);
      if (recomputed !== automation.nextRunAt || recomputedSlot !== automation.nextRunSlot) {
        automation.nextRunAt = recomputed;
        automation.nextRunSlot = recomputedSlot;
        automation.updatedAt = now;
        pair.updatedAt = now;
        changed += 1;
      }
    }
    if (changed > 0) {
      this.queueSave();
      this.emit("change");
    }
    return changed;
  }

  findPairByWorkerThread(threadId: string): PairChat | null {
    for (const pair of this.pairs.values()) {
      if (pair.worker?.threadId === threadId) return this.getPair(pair.id);
    }
    return null;
  }

  createPair(input: { title?: string | null; defaultCwd?: string | null } = {}): PairChat {
    const now = Date.now();
    const pair = emptyPair({ id: crypto.randomUUID(), title: input.title ?? DEFAULT_TITLE, defaultCwd: input.defaultCwd, now });
    if (this.lastUsedCompose) {
      pair.butlerThinkingLevel = this.lastUsedCompose.butlerThinkingLevel ?? null;
      pair.butlerModel = this.lastUsedCompose.butlerModel ?? null;
    }
    this.pairs.set(pair.id, pair);
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id)!;
  }

  updatePairTitle(pairId: string, rawTitle: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair || !normalizeText(rawTitle)) {
      return null;
    }
    const next = titleFromText(rawTitle);
    if (next !== pair.title) {
      pair.title = next;
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pair.id);
  }

  updatePairDefaultCwd(pairId: string, rawCwd: string | null): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;
    const next = normalizeText(rawCwd) || null;
    if (pair.defaultCwd !== next) {
      pair.defaultCwd = next;
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pair.id);
  }

  updateDefaultPairTitle(pairId: string, rawTitle: string): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair || !pairTitleIsDefault(pair.title) || !normalizeText(rawTitle)) {
      return null;
    }
    const next = titleFromText(rawTitle);
    if (next !== pair.title) {
      pair.title = next;
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
    }
    return this.getPair(pair.id);
  }

  updatePairSnapshot(pairId: string, snapshot: PairSnapshotInput): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (snapshot.butlerSessionId !== undefined) pair.butlerSessionId = snapshot.butlerSessionId;
    if (snapshot.butlerReady !== undefined) pair.butlerReady = snapshot.butlerReady;
    if (snapshot.butlerPending !== undefined) pair.butlerPending = snapshot.butlerPending;
    if (snapshot.butlerPendingReason !== undefined) pair.butlerPendingReason = snapshot.butlerPendingReason;
    if (snapshot.butlerLastError !== undefined) pair.butlerLastError = snapshot.butlerLastError;
    if (snapshot.messageCount !== undefined) pair.messageCount = Math.max(0, Math.trunc(snapshot.messageCount));
    if (snapshot.lastMessage !== undefined) pair.lastMessage = snapshot.lastMessage;
    const reviewedAt = reviewedReportUpdatedAt(pair, this.store, snapshot.lastMessage);
    if (reviewedAt && pair.worker && (!pair.worker.lastReviewedReportAt || reviewedAt > pair.worker.lastReviewedReportAt)) {
      pair.worker.lastReviewedReportAt = reviewedAt;
    }
    if (snapshot.butlerThinkingLevel !== undefined) pair.butlerThinkingLevel = snapshot.butlerThinkingLevel;
    if (snapshot.butlerModel !== undefined) pair.butlerModel = snapshot.butlerModel;
    if (snapshot.workerHarness !== undefined) pair.workerHarness = snapshot.workerHarness;
    if (snapshot.workerModel !== undefined) pair.workerModel = snapshot.workerModel;
    if (snapshot.workerEffort !== undefined) pair.workerEffort = snapshot.workerEffort;
    pair.status = deriveStatus(pair, this.store);
    pair.updatedAt = Math.max(pair.updatedAt, snapshot.updatedAt ?? pair.lastMessage?.at ?? Date.now());
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  updatePairComposeOverrides(pairId: string, override: PairComposeOverrideInput): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    if (override.butlerThinkingLevel !== undefined) pair.butlerThinkingLevel = override.butlerThinkingLevel;
    if (override.butlerModel !== undefined) pair.butlerModel = override.butlerModel;
    if (override.workerHarness !== undefined) pair.workerHarness = override.workerHarness;
    if (override.workerModel !== undefined) pair.workerModel = override.workerModel;
    if (override.workerEffort !== undefined) pair.workerEffort = override.workerEffort;
    pair.updatedAt = Math.max(pair.updatedAt, Date.now());
    this.lastUsedCompose = normalizeLastUsedCompose({
      butlerModel: override.butlerModel !== undefined ? override.butlerModel : this.lastUsedCompose?.butlerModel ?? null,
      butlerThinkingLevel: override.butlerThinkingLevel !== undefined ? override.butlerThinkingLevel : this.lastUsedCompose?.butlerThinkingLevel ?? null,
      workerHarness: override.workerHarness !== undefined ? override.workerHarness : this.lastUsedCompose?.workerHarness ?? null,
      workerModel: override.workerModel !== undefined ? override.workerModel : this.lastUsedCompose?.workerModel ?? null,
      workerEffort: override.workerEffort !== undefined ? override.workerEffort : this.lastUsedCompose?.workerEffort ?? null,
      updatedAt: Date.now()
    });
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  attachWorker(pairId: string, input: {
    threadId: string;
    task?: string | null;
    cwd?: string | null;
    handoffPrompt?: string | null;
    runtime?: "openai" | "pi-rpc" | null;
    harness?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    replacesThreadId?: string | null;
  }): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      return null;
    }
    const expectedThreadId = normalizeText(input.replacesThreadId) || null;
    if (
      expectedThreadId
        ? pair.worker?.threadId !== expectedThreadId && pair.worker?.threadId !== input.threadId
        : Boolean(pair.worker && pair.worker.threadId !== input.threadId)
    ) {
      pair.updatedAt = Date.now();
      this.queueSave();
      this.emit("change");
      return this.getPair(pair.id);
    }
    const thread = this.store.getThread(input.threadId);
    const now = Date.now();
    const sameWorker = pair.worker?.threadId === input.threadId ? pair.worker : null;
    const previousWorker = pair.worker?.threadId === expectedThreadId ? pair.worker : null;
    const runtime = input.runtime === undefined
      ? sameWorker?.runtime ?? normalizeWorkerRuntime(null, input.threadId, thread?.source)
      : normalizeWorkerRuntime(input.runtime, input.threadId, thread?.source);
    pair.worker = {
      threadId: input.threadId,
      runtime,
      harness: input.harness === undefined
        ? sameWorker?.harness ?? normalizeWorkerHarness(null, runtime)
        : normalizeWorkerHarness(input.harness, runtime),
      provider: input.provider === undefined
        ? sameWorker?.provider ?? thread?.modelProvider ?? null
        : normalizeText(input.provider) || null,
      model: input.model === undefined
        ? sameWorker?.model ?? null
        : normalizeText(input.model) || null,
      status: thread?.status === "active" ? "running" : thread?.status === "idle" ? "idle" : "starting",
      task: normalizeText(input.task) || sameWorker?.task || thread?.executionContract?.requestedTask || thread?.supervisor.latestUserPrompt || "Delegated Worker job",
      cwd: normalizeText(input.cwd) || sameWorker?.cwd || thread?.cwd || null,
      handoffPrompt: normalizeText(input.handoffPrompt) || sameWorker?.handoffPrompt || thread?.executionContract?.requestedTask || "",
      startedAt: sameWorker?.startedAt ?? now,
      lastRevertAt: sameWorker?.lastRevertAt ?? null,
      lastReportAt: sameWorker?.lastReportAt ?? null,
      lastReportStatus: sameWorker?.lastReportStatus ?? null,
      lastReportSummary: sameWorker?.lastReportSummary ?? null,
      lastReviewedReportAt: sameWorker?.lastReviewedReportAt ?? null,
      requestedReasoningEffort: input.effort === undefined
        ? sameWorker?.requestedReasoningEffort ?? thread?.requestedReasoningEffort ?? null
        : normalizeText(input.effort) || null,
      handedOffFrom: sameWorker?.handedOffFrom
        ? cloneWorkerHandoff(sameWorker.handedOffFrom)
        : previousWorker ? {
            threadId: previousWorker.threadId,
            runtime: previousWorker.runtime ?? null,
            harness: previousWorker.harness ?? null,
            provider: previousWorker.provider ?? null,
            model: previousWorker.model ?? null,
            ...(previousWorker.handedOffFrom ? { handedOffFrom: cloneWorkerHandoff(previousWorker.handedOffFrom) } : {})
          } : null
    };
    pair.lastHandoffPrompt = pair.worker.handoffPrompt || null;
    pair.updatedAt = now;
    pair.status = deriveStatus(pair, this.store);
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  restoreWorkerIfCurrent(pairId: string, expectedThreadId: string, worker: PairWorker | null, defaultCwd?: string | null): boolean {
    const pair = this.pairs.get(pairId);
    if (!pair || pair.worker?.threadId !== expectedThreadId) return false;
    pair.worker = clonePairWorker(worker);
    if (defaultCwd !== undefined) pair.defaultCwd = normalizeText(defaultCwd) || null;
    pair.lastHandoffPrompt = pair.worker?.handoffPrompt || null;
    pair.updatedAt = Date.now();
    pair.status = deriveStatus(pair, this.store);
    this.queueSave();
    this.emit("change");
    return true;
  }

  updateWorkerEffort(pairId: string, threadId: string, effort: string | null): PairChat | null {
    const pair = this.pairs.get(pairId);
    if (!pair?.worker || pair.worker.threadId !== threadId) return pair ? this.getPair(pair.id) : null;
    pair.worker.requestedReasoningEffort = normalizeText(effort) || null;
    pair.updatedAt = Date.now();
    this.queueSave();
    this.emit("change");
    return this.getPair(pair.id);
  }

  syncWorkerReports(): boolean {
    let changed = false;
    for (const pair of this.pairs.values()) {
      if (!pair.worker) {
        continue;
      }
      const thread = this.store.getThread(pair.worker.threadId);
      if (!thread) {
        pair.worker = null;
        pair.lastHandoffPrompt = null;
        pair.workerHarness = null;
        pair.workerModel = null;
        pair.workerEffort = null;
        pair.updatedAt = Date.now();
        pair.status = deriveStatus(pair, this.store);
        changed = true;
        continue;
      }
      const report = this.store.getWorkerReport(pair.worker.threadId);
      const nextStatus = thread?.status === "active" ? "running" : thread?.status === "idle" ? "idle" : thread?.status === "unknown" ? "unknown" : pair.worker.status;
      if (pair.worker.status !== nextStatus) {
        pair.worker.status = nextStatus;
        changed = true;
      }
      if (report && report.updatedAt !== pair.worker.lastReportAt) {
        pair.worker.lastReportAt = report.updatedAt;
        pair.worker.lastReportStatus = report.status;
        pair.worker.lastReportSummary = report.summary;
        pair.updatedAt = Math.max(pair.updatedAt, report.updatedAt);
        changed = true;
      }
      const reviewedAt = reviewedReportUpdatedAt(pair, this.store, pair.lastMessage);
      if (reviewedAt && (!pair.worker.lastReviewedReportAt || reviewedAt > pair.worker.lastReviewedReportAt)) {
        pair.worker.lastReviewedReportAt = reviewedAt;
        changed = true;
      }
      const nextPairStatus = deriveStatus(pair, this.store);
      if (pair.status !== nextPairStatus) {
        pair.status = nextPairStatus;
        changed = true;
      }
    }
    if (changed) {
      this.queueSave();
      this.emit("change");
    }
    return changed;
  }

  deletePair(pairId: string): boolean {
    const deleted = this.pairs.delete(pairId);
    if (deleted) {
      this.queueSave();
      this.emit("change");
    }
    return deleted;
  }

  restorePairAfterFailedDelete(pair: PairChat): void {
    if (this.pairs.has(pair.id)) return;
    this.pairs.set(pair.id, pair);
    this.queueSave();
    this.emit("change");
  }

  async flushPendingSave(): Promise<void> {
    while (this.saveInFlight || this.saveQueued) {
      if (!this.saveInFlight) this.queueSave();
      await this.saveInFlight;
    }
  }

  private queueSave(): void {
    this.saveQueued = true;
    if (this.saveInFlight) {
      return;
    }
    this.saveInFlight = this.flushSave().finally(() => {
      this.saveInFlight = null;
      if (this.saveQueued) {
        this.queueSave();
      }
    });
  }

  private async flushSave(): Promise<void> {
    this.saveQueued = false;
    await writeJsonStateFileAtomic(this.statePath, {
      pairs: [...this.pairs.values()].sort((left, right) => left.createdAt - right.createdAt),
      lastUsedCompose: this.lastUsedCompose,
      workerAffinity: this.workerAffinity
    } satisfies PersistedPairState);
  }
}
