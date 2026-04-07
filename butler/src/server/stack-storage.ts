import type { StackLeaseView, StackStorageMode } from "./types.js";

export function normalizeStackStorageMode(value: unknown): StackStorageMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "ephemeral" || normalized === "job" || normalized === "base" || normalized === "custom") {
    return normalized;
  }
  return null;
}

export function formatStackStorageSummary(
  stack: Pick<
    StackLeaseView,
    "storageMode" | "baseStorageKey" | "storageKey" | "cloneFromStorageKey" | "defaultPromoteTargetStorageKey" | "retainsVolumes" | "volumeNames"
  >
): string {
  const parts = [`mode=${stack.storageMode}`];
  if (stack.storageKey) {
    parts.push(`key=${stack.storageKey}`);
  }
  if (stack.baseStorageKey) {
    parts.push(`base=${stack.baseStorageKey}`);
  }
  if (stack.cloneFromStorageKey) {
    parts.push(`fork=${stack.cloneFromStorageKey}`);
  }
  if (stack.defaultPromoteTargetStorageKey) {
    parts.push(`promote=${stack.defaultPromoteTargetStorageKey}`);
  }
  parts.push(`sticky=${stack.retainsVolumes ? stack.volumeNames.length : 0}`);
  return parts.join(" | ");
}
