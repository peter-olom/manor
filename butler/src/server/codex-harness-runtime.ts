import { normalizeString } from "./codex-harness-helpers.js";
import { ButlerStateStore } from "./state-store.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import type { PreviewLeaseView, ServiceLeaseView, StackLeaseView } from "./types.js";

type HarnessRuntimeAccess = {
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
  serviceTemplateRegistry: ServiceTemplateRegistry;
};

function matchByIdTitleAndAliases<T extends { id: string; title: string; aliases?: string[] }>(
  leases: T[],
  selector: string,
  options?: { matchAliases?: boolean }
): T | null {
  const normalizedSelector = normalizeString(selector);
  if (!normalizedSelector) {
    return null;
  }

  const directIdMatch = leases.find((lease) => lease.id === normalizedSelector);
  if (directIdMatch) {
    return directIdMatch;
  }

  const exactTitleMatches = leases.filter((lease) => lease.title === normalizedSelector);
  if (exactTitleMatches.length === 1) {
    return exactTitleMatches[0];
  }

  if (options?.matchAliases) {
    const exactAliasMatches = leases.filter((lease) => lease.aliases?.includes(normalizedSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }
  }

  const foldedSelector = normalizedSelector.toLowerCase();
  const foldedTitleMatches = leases.filter((lease) => lease.title.trim().toLowerCase() === foldedSelector);
  if (foldedTitleMatches.length === 1) {
    return foldedTitleMatches[0];
  }

  if (options?.matchAliases) {
    const foldedAliasMatches = leases.filter((lease) =>
      lease.aliases?.some((alias) => alias.trim().toLowerCase() === foldedSelector)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }
  }

  return null;
}

function isStackVisibleToThread(stack: StackLeaseView, threadId: string): boolean {
  return stack.threadId === threadId || !stack.threadId || stack.pinned === true;
}

function isLeaseVisibleToThread(
  store: ButlerStateStore,
  lease: PreviewLeaseView | ServiceLeaseView,
  threadId: string
): boolean {
  if (lease.threadId === threadId || !lease.threadId || lease.pinned === true) {
    return true;
  }

  const stack = lease.stackId ? store.getStackLease(lease.stackId) : null;
  return Boolean(stack && isStackVisibleToThread(stack, threadId));
}

export function matchHarnessThreadPreview(store: ButlerStateStore, threadId: string, selector: string): PreviewLeaseView | null {
  return matchByIdTitleAndAliases(
    store.listPreviewLeases().filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(store, lease, threadId)),
    selector,
    { matchAliases: true }
  );
}

export function matchHarnessThreadService(store: ButlerStateStore, threadId: string, selector: string): ServiceLeaseView | null {
  return matchByIdTitleAndAliases(
    store.listServiceLeases().filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(store, lease, threadId)),
    selector,
    { matchAliases: true }
  );
}

export function matchHarnessThreadStack(store: ButlerStateStore, threadId: string, selector: string): StackLeaseView | null {
  return matchByIdTitleAndAliases(
    store.listStackLeases().filter((lease) => lease.status !== "stopped" && isStackVisibleToThread(lease, threadId)),
    selector
  );
}

export async function resolveHarnessThreadStack(access: HarnessRuntimeAccess, threadId: string, stackSelector: string): Promise<StackLeaseView> {
  const storedMatch = matchHarnessThreadStack(access.store, threadId, stackSelector);
  if (storedMatch) {
    return storedMatch;
  }

  await reconcileHarnessThreadStacks(access, threadId);
  const refreshedMatch = matchHarnessThreadStack(access.store, threadId, stackSelector);
  if (refreshedMatch) {
    return refreshedMatch;
  }

  throw new Error(`Stack ${stackSelector} is not attached to this job`);
}

export async function resolveHarnessThreadPreview(access: HarnessRuntimeAccess, threadId: string, previewSelector: string): Promise<PreviewLeaseView> {
  const storedMatch = matchHarnessThreadPreview(access.store, threadId, previewSelector);
  if (storedMatch) {
    return storedMatch;
  }

  await reconcileHarnessThreadPreviews(access, threadId);
  const refreshedMatch = matchHarnessThreadPreview(access.store, threadId, previewSelector);
  if (refreshedMatch) {
    return refreshedMatch;
  }

  throw new Error(`Preview ${previewSelector} is not attached to this job`);
}

export async function resolveHarnessThreadService(access: HarnessRuntimeAccess, threadId: string, serviceSelector: string): Promise<ServiceLeaseView> {
  const storedMatch = matchHarnessThreadService(access.store, threadId, serviceSelector);
  if (storedMatch) {
    return storedMatch;
  }

  await reconcileHarnessThreadServices(access, threadId);
  const refreshedMatch = matchHarnessThreadService(access.store, threadId, serviceSelector);
  if (refreshedMatch) {
    return refreshedMatch;
  }

  throw new Error(`Service ${serviceSelector} is not attached to this job`);
}

export function removeHarnessStackArtifacts(store: ButlerStateStore, stackId: string): void {
  for (const lease of store.listPreviewLeases()) {
    if (lease.stackId === stackId) {
      store.removePreviewLease(lease.id);
    }
  }
  for (const lease of store.listServiceLeases()) {
    if (lease.stackId === stackId) {
      store.removeServiceLease(lease.id);
    }
  }
  store.removeStackLease(stackId);
}

export async function reconcileHarnessThreadPreviews(access: HarnessRuntimeAccess, threadId: string): Promise<PreviewLeaseView[]> {
  const brokerLeases = await access.runtimeBroker.listLeases();
  const brokerLeaseMap = new Map(brokerLeases.map((lease) => [lease.id, lease]));
  const storedLeases = access.store
    .listPreviewLeases()
    .filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(access.store, lease, threadId));

  for (const lease of storedLeases) {
    if (!brokerLeaseMap.has(lease.id)) {
      access.store.removePreviewLease(lease.id);
    }
  }

  for (const lease of brokerLeases) {
    access.store.upsertPreviewLease(lease);
  }

  return access.store
    .listPreviewLeases()
    .filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(access.store, lease, threadId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function reconcileHarnessThreadStacks(access: HarnessRuntimeAccess, threadId: string): Promise<StackLeaseView[]> {
  const brokerStacks = await access.runtimeBroker.listStacks();
  const brokerStackIds = new Set(brokerStacks.map((stack) => stack.id));
  const storedStacks = access.store
    .listStackLeases()
    .filter((lease) => lease.status !== "stopped" && isStackVisibleToThread(lease, threadId));

  for (const lease of storedStacks) {
    if (!brokerStackIds.has(lease.id)) {
      access.store.removeStackLease(lease.id);
    }
  }

  for (const stack of brokerStacks) {
    access.store.upsertStackLease(stack);
  }

  return access.store.listStackLeases().filter((lease) => lease.status !== "stopped" && isStackVisibleToThread(lease, threadId));
}

export async function reconcileHarnessThreadServices(access: HarnessRuntimeAccess, threadId: string): Promise<ServiceLeaseView[]> {
  const brokerServices = await access.runtimeBroker.listServices();
  const brokerServiceIds = new Set(brokerServices.map((service) => service.id));
  const storedServices = access.store
    .listServiceLeases()
    .filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(access.store, lease, threadId));

  for (const lease of storedServices) {
    if (lease.runtimeKind === "container" && !brokerServiceIds.has(lease.id)) {
      access.store.removeServiceLease(lease.id);
    }
  }

  for (const service of brokerServices) {
    const template = access.serviceTemplateRegistry.get(service.templateId);
    if (!template) {
      continue;
    }

    access.store.upsertServiceLease(
      toServiceLeaseView({
        id: service.id,
        threadId: service.threadId,
        projectId: service.projectId,
        projectLabel: service.projectLabel,
        title: service.title,
        stackId: service.stackId,
        aliases: service.aliases,
        template,
        containerName: service.containerName,
        targetHost: service.targetHost,
        targetPort: service.targetPort,
        worktreePath: service.worktreePath,
        status: service.status,
        storageKind: service.storageKind,
        sticky: service.sticky,
        volumeName: service.volumeName,
        volumeMountPath: service.volumeMountPath,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        lastError: service.lastError,
        env: service.env
      })
    );
  }

  return access.store
    .listServiceLeases()
    .filter((lease) => lease.status !== "stopped" && isLeaseVisibleToThread(access.store, lease, threadId));
}
