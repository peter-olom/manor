import { promises as fs } from "node:fs";

import type {
  ProjectArtifactView,
  ProjectPolicyView
} from "./types.js";
import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";
import { searchStateStoreSqliteProjectArtifacts } from "./state-store-sqlite-memory.js";

type ProjectArtifactSearchInput = {
  projectId?: string | null;
  query?: string | null;
  kind?: ProjectArtifactView["kind"] | null;
  tags?: string[];
  limit?: number | null;
};

function cloneArtifact(artifact: ProjectArtifactView): ProjectArtifactView {
  return {
    ...artifact,
    tags: [...artifact.tags],
    metadata: { ...artifact.metadata },
    source: { ...artifact.source }
  };
}

function clonePolicy(policy: ProjectPolicyView): ProjectPolicyView {
  return {
    ...policy,
    artifacts: [...policy.artifacts],
    triggers: [...policy.triggers]
  };
}

export function listStateStoreProjectArtifacts(
  access: StateStoreInternalAccess,
  projectId?: string | null
): ProjectArtifactView[] {
  const entries = projectId
    ? access.persistedProjectArtifactsByProjectId.get(projectId) ?? []
    : [...access.persistedProjectArtifactsByProjectId.values()].flat();
  return entries.map((artifact) => cloneArtifact(artifact)).sort((left, right) => right.updatedAt - left.updatedAt);
}

function normalizeQuery(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function normalizeLimit(value: number | null | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(typeof value === "number" && Number.isFinite(value) ? value : 20)));
}

function artifactMatchesFilters(artifact: ProjectArtifactView, input: ProjectArtifactSearchInput): boolean {
  const tags = normalizeTags(input.tags);
  if (input.projectId && artifact.projectId !== input.projectId) {
    return false;
  }
  if (input.kind && artifact.kind !== input.kind) {
    return false;
  }
  if (tags.length > 0) {
    const artifactTags = new Set(artifact.tags.map((tag) => tag.toLowerCase()));
    if (!tags.every((tag) => artifactTags.has(tag))) {
      return false;
    }
  }
  return true;
}

function artifactSearchText(artifact: ProjectArtifactView): string {
  return [
    artifact.title,
    artifact.description,
    artifact.fileName,
    artifact.contentType,
    artifact.kind,
    artifact.projectLabel,
    artifact.tags.join(" "),
    Object.entries(artifact.metadata).flatMap(([key, value]) => [key, value]).join(" "),
    artifact.source.url,
    artifact.textPreview
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n")
    .toLowerCase();
}

function fallbackSearchProjectArtifacts(access: StateStoreInternalAccess, input: ProjectArtifactSearchInput): ProjectArtifactView[] {
  const query = normalizeQuery(input.query);
  const terms = query.match(/[a-z0-9]+/g) ?? [];
  return listStateStoreProjectArtifacts(access, input.projectId)
    .filter((artifact) => artifactMatchesFilters(artifact, input))
    .filter((artifact) => {
      if (terms.length === 0) {
        return true;
      }
      const text = artifactSearchText(artifact);
      return terms.every((term) => text.includes(term));
    })
    .slice(0, normalizeLimit(input.limit));
}

export async function searchStateStoreProjectArtifacts(
  access: StateStoreInternalAccess,
  input: ProjectArtifactSearchInput
): Promise<ProjectArtifactView[]> {
  const query = normalizeQuery(input.query);
  const limit = normalizeLimit(input.limit);
  if (!query) {
    return fallbackSearchProjectArtifacts(access, { ...input, limit });
  }

  try {
    const indexed = await searchStateStoreSqliteProjectArtifacts(access, {
      projectId: input.projectId,
      query,
      kind: input.kind,
      limit
    });
    const filtered = indexed
      .filter((artifact) => getStateStoreProjectArtifact(access, artifact.projectId, artifact.id))
      .filter((artifact) => artifactMatchesFilters(artifact, input))
      .slice(0, limit);
    return filtered.length > 0 ? filtered : fallbackSearchProjectArtifacts(access, { ...input, limit });
  } catch {
    return fallbackSearchProjectArtifacts(access, { ...input, limit });
  }
}

export function getStateStoreProjectArtifact(
  access: StateStoreInternalAccess,
  projectId: string,
  artifactId: string
): ProjectArtifactView | null {
  const artifact =
    (access.persistedProjectArtifactsByProjectId.get(projectId) ?? []).find((entry) => entry.id === artifactId) ?? null;
  return artifact ? cloneArtifact(artifact) : null;
}

export function findStateStoreProjectArtifactById(
  access: StateStoreInternalAccess,
  artifactId: string
): ProjectArtifactView | null {
  for (const artifacts of access.persistedProjectArtifactsByProjectId.values()) {
    const match = artifacts.find((entry) => entry.id === artifactId);
    if (match) {
      return cloneArtifact(match);
    }
  }
  return null;
}

export function upsertStateStoreProjectArtifact(
  access: StateStoreInternalAccess,
  artifact: ProjectArtifactView
): ProjectArtifactView {
  const existing = access.persistedProjectArtifactsByProjectId.get(artifact.projectId) ?? [];
  const next = [...existing];
  const index = next.findIndex((entry) => entry.id === artifact.id);
  const value = cloneArtifact(artifact);
  if (index === -1) {
    next.push(value);
  } else {
    next[index] = value;
  }
  access.persistedProjectArtifactsByProjectId.set(
    artifact.projectId,
    next.sort((left, right) => right.updatedAt - left.updatedAt)
  );
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return cloneArtifact(value);
}

export function removeStateStoreProjectArtifact(
  access: StateStoreInternalAccess,
  projectId: string,
  artifactId: string
): ProjectArtifactView | null {
  const existing = access.persistedProjectArtifactsByProjectId.get(projectId) ?? [];
  const artifact = existing.find((entry) => entry.id === artifactId) ?? null;
  if (!artifact) {
    return null;
  }
  const remaining = existing.filter((entry) => entry.id !== artifactId);
  if (remaining.length > 0) {
    access.persistedProjectArtifactsByProjectId.set(projectId, remaining);
  } else {
    access.persistedProjectArtifactsByProjectId.delete(projectId);
  }
  const policies = access.persistedProjectPoliciesByProjectId.get(projectId) ?? [];
  const nextPolicies = policies.map((policy) => ({ ...policy, artifacts: policy.artifacts.filter((entry) => entry !== artifactId) }));
  if (nextPolicies.some((policy, index) => policy.artifacts.length !== policies[index]?.artifacts.length)) {
    access.persistedProjectPoliciesByProjectId.set(projectId, nextPolicies);
  }
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return cloneArtifact(artifact);
}

export async function pruneMissingStateStoreProjectArtifacts(
  access: StateStoreInternalAccess,
  projectId?: string | null
): Promise<number> {
  let removed = 0;
  for (const artifact of listStateStoreProjectArtifacts(access, projectId)) {
    try {
      await fs.access(artifact.filePath);
    } catch {
      if (removeStateStoreProjectArtifact(access, artifact.projectId, artifact.id)) {
        removed += 1;
      }
    }
  }
  return removed;
}

export function listStateStoreProjectPolicies(
  access: StateStoreInternalAccess,
  projectId?: string | null
): ProjectPolicyView[] {
  const entries = projectId
    ? access.persistedProjectPoliciesByProjectId.get(projectId) ?? []
    : [...access.persistedProjectPoliciesByProjectId.values()].flat();
  return entries.map((policy) => clonePolicy(policy)).sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getStateStoreProjectPolicy(
  access: StateStoreInternalAccess,
  projectId: string,
  policyId: string
): ProjectPolicyView | null {
  const policy =
    (access.persistedProjectPoliciesByProjectId.get(projectId) ?? []).find((entry) => entry.id === policyId) ?? null;
  return policy ? clonePolicy(policy) : null;
}

export function upsertStateStoreProjectPolicy(
  access: StateStoreInternalAccess,
  policy: ProjectPolicyView
): ProjectPolicyView {
  const existing = access.persistedProjectPoliciesByProjectId.get(policy.projectId) ?? [];
  const next = [...existing];
  const index = next.findIndex((entry) => entry.id === policy.id);
  const value = clonePolicy(policy);
  if (index === -1) {
    next.push(value);
  } else {
    next[index] = value;
  }
  access.persistedProjectPoliciesByProjectId.set(
    policy.projectId,
    next.sort((left, right) => right.updatedAt - left.updatedAt)
  );
  queueStateStoreSave(access);
  emitStateStoreChange(access);
  return clonePolicy(value);
}
