import type {
  ActivityWatchdogPolicyId,
  ActivityWatchdogSnapshot
} from "../shared/activity-watchdog.js";

export const ACTIVITY_WATCHDOG_POLICIES: Record<
  ActivityWatchdogPolicyId,
  { label: string; intervalMs: number }
> = {
  "delegation-reconciliation": {
    label: "Worker handoff",
    intervalMs: 10_000
  },
  "callback-review-currency": {
    label: "Review context",
    intervalMs: 50
  },
  "review-activity": {
    label: "Review activity",
    intervalMs: 100
  }
};

export type ActivityWatchdogRegistrationInput = {
  /** Unique identifier used to prevent duplicate registrations. */
  id: string;
  /** Named policy controls the default cadence and operator-facing label. */
  policy: ActivityWatchdogPolicyId;
  /** Human-readable subject such as the supervised Worker thread. */
  target?: string | null;
  /** Keeps checks responsive when a configured inactivity limit is shorter than the policy cadence. */
  maxIntervalMs?: number;
  /** Work performed on every interval until the registration is removed. */
  callback: () => void;
};

export interface ActivityWatchdogRegistration {
  readonly id: string;
  readonly policy: ActivityWatchdogPolicyId;
  readonly intervalMs: number;
  unregister(): void;
}

type ActivityWatchdogEntry = {
  snapshot: ActivityWatchdogSnapshot;
  timer: ReturnType<typeof setInterval>;
};

export class ActivityWatchdogService {
  // Registrations live only for the lifetime of this process; callbacks cannot be persisted.
  private readonly registrations = new Map<string, ActivityWatchdogEntry>();

  get size(): number {
    return this.registrations.size;
  }

  register(input: ActivityWatchdogRegistrationInput): ActivityWatchdogRegistration {
    const id = input.id.trim();
    if (!id) throw new Error("Activity watchdog registration id is required.");
    const policy = ACTIVITY_WATCHDOG_POLICIES[input.policy];
    if (!policy) throw new Error(`Unknown activity watchdog policy: ${input.policy}`);
    if (input.maxIntervalMs !== undefined && (!Number.isFinite(input.maxIntervalMs) || input.maxIntervalMs <= 0)) {
      throw new RangeError("Activity watchdog maxIntervalMs must be greater than zero.");
    }
    if (this.registrations.has(id)) {
      throw new Error(`Activity watchdog registration already exists: ${id}`);
    }

    const intervalMs = Math.ceil(Math.min(policy.intervalMs, input.maxIntervalMs ?? policy.intervalMs));
    const snapshot: ActivityWatchdogSnapshot = {
      id,
      policy: input.policy,
      label: policy.label,
      target: input.target?.trim() || null,
      intervalMs,
      registeredAt: Date.now(),
      lastCheckedAt: null,
      checkCount: 0
    };
    const timer = setInterval(() => {
      snapshot.lastCheckedAt = Date.now();
      snapshot.checkCount += 1;
      input.callback();
    }, intervalMs);
    timer.unref?.();
    this.registrations.set(id, { snapshot, timer });

    return {
      id,
      policy: input.policy,
      intervalMs,
      unregister: () => {
        // Keep cleanup tied to the returned registration instead of exposing the timer handle.
        this.unregister(id);
      }
    };
  }

  unregister(id: string): boolean {
    const entry = this.registrations.get(id);
    if (!entry) return false;
    clearInterval(entry.timer);
    this.registrations.delete(id);
    return true;
  }

  snapshot(): ActivityWatchdogSnapshot[] {
    return [...this.registrations.values()]
      .map((entry) => ({ ...entry.snapshot }))
      .sort((left, right) => left.registeredAt - right.registeredAt || left.id.localeCompare(right.id));
  }

  clear(): void {
    // Intended for service shutdown and test cleanup.
    for (const entry of this.registrations.values()) clearInterval(entry.timer);
    this.registrations.clear();
  }
}
