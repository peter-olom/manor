import { ActivityWatchdogService } from "./activity-watchdog.js";

const DELEGATION_WATCHDOG_INTERVAL_MS = 10_000;

export class ButlerDelegationWatchdogs {
  private readonly checksInFlight = new Set<string>();

  constructor(private readonly options: {
    watchdogs: ActivityWatchdogService;
    isOutstanding: (threadId: string) => boolean;
    check: (threadId: string) => Promise<void>;
    onError: (error: unknown) => void;
  }) {}

  register(threadId: string): void {
    const id = this.registrationId(threadId);
    this.unregister(threadId);
    this.options.watchdogs.register({
      id,
      intervalMs: DELEGATION_WATCHDOG_INTERVAL_MS,
      callback: () => { void this.runCheck(threadId); }
    });
  }

  unregister(threadId: string): void {
    this.options.watchdogs.unregister(this.registrationId(threadId));
    // An interval can be replaced while its previous check is still running.
    // Keep that check marked in flight until its own finally block completes so
    // the replacement interval cannot start an overlapping check.
  }

  private registrationId(threadId: string): string {
    return `delegation:${threadId}`;
  }

  private async runCheck(threadId: string): Promise<void> {
    if (!this.options.isOutstanding(threadId)) {
      this.unregister(threadId);
      return;
    }
    if (this.checksInFlight.has(threadId)) return;
    this.checksInFlight.add(threadId);
    try {
      await this.options.check(threadId);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.checksInFlight.delete(threadId);
      if (!this.options.isOutstanding(threadId)) this.unregister(threadId);
    }
  }
}
