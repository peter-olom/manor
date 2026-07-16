export type ActivityWatchdogRegistrationInput = {
  /** Unique identifier used to prevent duplicate registrations. */
  id: string;
  /** How often this registration's callback should run. */
  intervalMs: number;
  /** Work performed on every interval until the registration is removed. */
  callback: () => void;
};

export interface ActivityWatchdogRegistration {
  readonly id: string;
  readonly intervalMs: number;
  unregister(): void;
}

export class ActivityWatchdogService {
  // Registrations live only for the lifetime of this process; callbacks cannot be persisted.
  private readonly registrations = new Map<string, ReturnType<typeof setInterval>>();

  get size(): number {
    return this.registrations.size;
  }

  register(input: ActivityWatchdogRegistrationInput): ActivityWatchdogRegistration {
    const id = input.id.trim();
    if (!id) throw new Error("Activity watchdog registration id is required.");
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
      throw new RangeError("Activity watchdog intervalMs must be greater than zero.");
    }
    if (this.registrations.has(id)) {
      throw new Error(`Activity watchdog registration already exists: ${id}`);
    }

    const intervalMs = Math.ceil(input.intervalMs);
    // Each registration owns an independent interval so callers can choose their cadence.
    const timer = setInterval(input.callback, intervalMs);
    timer.unref?.();
    this.registrations.set(id, timer);

    return {
      id,
      intervalMs,
      unregister: () => {
        // Keep cleanup tied to the returned registration instead of exposing the timer handle.
        this.unregister(id);
      }
    };
  }

  unregister(id: string): boolean {
    const timer = this.registrations.get(id);
    if (!timer) return false;
    clearInterval(timer);
    this.registrations.delete(id);
    return true;
  }

  clear(): void {
    // Intended for service shutdown and test cleanup.
    for (const timer of this.registrations.values()) clearInterval(timer);
    this.registrations.clear();
  }
}
