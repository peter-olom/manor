import type {
  ProjectArtifactView,
  ProjectPolicyView
} from "./types.js";
import {
  emitStateStoreChange,
  queueStateStoreSave,
  type StateStoreInternalAccess
} from "./state-store-internals.js";

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
