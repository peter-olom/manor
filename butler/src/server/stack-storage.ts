import type { StackLeaseView, StackStorageMode } from "./types.js";

export function normalizeStackStorageMode(value: unknown): StackStorageMode | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "ephemeral" || normalized === "job" || normalized === "base" || normalized === "custom") {
    return normalized;
  }
  return null;
}

export function projectStackStoragePrefix(projectId: string): string {
  const token = projectId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "stack";
  return `project-${token}-`;
}

export function assertProjectStackStorageLineage(
  projectId: string,
  keys: Array<{ name: string; value: string | null | undefined }>
): void {
  const prefix = projectStackStoragePrefix(projectId);
  for (const { name, value } of keys) {
    const normalized = value?.trim() || "";
    if (normalized && !normalized.startsWith(prefix)) {
      throw new Error(`${name} is outside the resolved project storage namespace.`);
    }
  }
}

export function resolveStackPromotionTarget(
  stack: Pick<StackLeaseView, "projectId" | "baseStorageKey" | "cloneFromStorageKey" | "defaultPromoteTargetStorageKey">,
  requestedTarget: unknown,
  confirmedTarget: unknown
): string {
  const target = typeof requestedTarget === "string" && requestedTarget.trim()
    ? requestedTarget.trim()
    : stack.defaultPromoteTargetStorageKey;
  if (!target) throw new Error("targetStorageKey is required");
  const lineage = new Set(
    [stack.defaultPromoteTargetStorageKey, stack.baseStorageKey, stack.cloneFromStorageKey]
      .map((value) => value?.trim() || null)
      .filter((value): value is string => Boolean(value))
  );
  if (!lineage.has(target)) throw new Error("The target storage key is outside this stack's project storage lineage.");
  assertProjectStackStorageLineage(stack.projectId, [{ name: "targetStorageKey", value: target }]);
  if (typeof confirmedTarget !== "string" || confirmedTarget.trim() !== target) {
    throw new Error("confirmTargetStorageKey must exactly match the target storage key before promotion.");
  }
  return target;
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
