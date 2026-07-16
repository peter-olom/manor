export type ActivityWatchdogPolicyId =
  | "delegation-reconciliation"
  | "callback-review-currency"
  | "review-activity";

export type ActivityWatchdogSnapshot = {
  id: string;
  policy: ActivityWatchdogPolicyId;
  label: string;
  target: string | null;
  intervalMs: number;
  registeredAt: number;
  lastCheckedAt: number | null;
  checkCount: number;
};

export type ActivityWatchdogDiagnostics = {
  activeCount: number;
  watchdogs: ActivityWatchdogSnapshot[];
};
