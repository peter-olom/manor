import type { PairAutomation, PairAutomationOutcome, PairChat } from "../shared/pairing.js";
import type { PairStore } from "./pair-store.js";

export type AutomationDispatchResult = {
  outcome: PairAutomationOutcome;
  summary: string;
  resultPath?: string | null;
};

export type SessionAutomationDispatcher = (input: {
  pairId: string;
  automation: PairAutomation;
  run: NonNullable<PairAutomation["running"]>;
}) => Promise<AutomationDispatchResult>;

function pairIsBusy(pair: PairChat): boolean {
  const unansweredQuestion = Boolean(pair.lastMessage?.question && !pair.lastMessage.question.answeredAt);
  return pair.butlerPending || Boolean(pair.butlerPendingReason) || unansweredQuestion ||
    pair.status === "butler_running" || pair.status === "worker_running" || pair.status === "needs_butler_review" ||
    pair.worker?.status === "running" || pair.worker?.status === "starting";
}

export class SessionAutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly options: {
    pairStore: PairStore;
    dispatch: SessionAutomationDispatcher;
    intervalMs?: number;
    now?: () => number;
    isBusy?: (pair: PairChat) => boolean;
    onSkipped?: (pairId: string, message: string) => Promise<void>;
  }) {}

  start(): void {
    if (this.timer) return;
    this.options.pairStore.reconcileAutomationsAfterRestart(this.now());
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.options.pairStore.listSummaries().filter((pair) =>
        pair.automation?.enabled && !pair.automation.running && pair.automation.nextRunAt !== null && pair.automation.nextRunAt <= now
      );
      for (const pair of due) {
        const automation = pair.automation!;
        const run = this.options.pairStore.claimAutomationRun(pair.id, automation.id, now);
        if (!run) continue;
        try {
          await this.options.pairStore.flushPendingSave();
        } catch (error) {
          this.options.pairStore.finishAutomationRun(pair.id, automation.id, run.id, {
            outcome: "failed",
            summary: `Could not persist the scheduled run before dispatch: ${error instanceof Error ? error.message : String(error)}`
          }, now);
          continue;
        }
        if ((this.options.isBusy ?? pairIsBusy)(pair)) {
          const message = "Automation skipped because this session was already active.";
          this.options.pairStore.finishAutomationRun(pair.id, automation.id, run.id, {
            outcome: "skipped",
            summary: message
          }, now);
          void this.options.onSkipped?.(pair.id, message).catch(() => undefined);
          continue;
        }
        void this.options.dispatch({ pairId: pair.id, automation, run }).then((result) => {
          this.options.pairStore.finishAutomationRun(pair.id, automation.id, run.id, result, this.now());
        }).catch((error) => {
          this.options.pairStore.finishAutomationRun(pair.id, automation.id, run.id, {
            outcome: "failed",
            summary: error instanceof Error ? error.message : String(error)
          }, this.now());
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
