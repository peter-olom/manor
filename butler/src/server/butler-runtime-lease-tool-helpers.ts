export function normalizeLeaseTtlMs(leaseTtlMinutes: unknown): number | null {
  const numeric = typeof leaseTtlMinutes === "number" ? leaseTtlMinutes : Number(leaseTtlMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(60_000, Math.trunc(numeric * 60_000));
}

export function resolveStickyFlag(input: { sticky?: boolean; pinned?: boolean }): boolean | undefined {
  if (typeof input.sticky === "boolean") return input.sticky;
  if (typeof input.pinned === "boolean") return input.pinned;
  return undefined;
}

export function withRequestedLeaseLifecycle<T extends object>(
  lease: T,
  input: { sticky?: boolean; pinned?: boolean; leaseTtlMinutes?: number }
): T & { pinned?: boolean; leaseTtlMs?: number | null } {
  const pinned = resolveStickyFlag(input);
  const leaseTtlMs = normalizeLeaseTtlMs(input.leaseTtlMinutes);
  return {
    ...lease,
    ...(typeof pinned === "boolean" ? { pinned } : {}),
    ...(leaseTtlMs !== null ? { leaseTtlMs } : {})
  };
}

export function formatLeaseLifecycle(lease: {
  pinned?: boolean;
  lifecycleState?: string;
  leaseTtlMs?: number | null;
  expiresAt?: number | null;
} & object): string {
  const state = lease.pinned ? "sticky" : lease.lifecycleState ?? "active";
  const ttlMinutes =
    typeof lease.leaseTtlMs === "number" && Number.isFinite(lease.leaseTtlMs)
      ? Math.max(1, Math.round(lease.leaseTtlMs / 60_000))
      : null;
  const expiry =
    typeof lease.expiresAt === "number" && Number.isFinite(lease.expiresAt)
      ? ` expires=${new Date(lease.expiresAt).toISOString()}`
      : "";
  return `lease=${state}${ttlMinutes ? ` ttl=${ttlMinutes}m` : ""}${expiry}`;
}

export function requireCaptureMetadata(
  label: string | undefined,
  fileName: string | undefined,
  action: string
): void {
  if (!label?.trim()) throw new Error(`${action} requires a screenshot label.`);
  if (!/^[^/\\]+\.png$/i.test(fileName?.trim() ?? "")) {
    throw new Error(`${action} requires a plain .png screenshot fileName.`);
  }
}
