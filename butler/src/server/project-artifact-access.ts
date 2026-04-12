import type { ProjectArtifactView } from "./types.js";

const internalBaseUrl = normalizeBaseUrl(process.env.MANOR_ARTIFACTS_INTERNAL_BASE_URL ?? "http://butler:8080");
const publicBaseUrl = normalizeBaseUrl(process.env.MANOR_ARTIFACTS_PUBLIC_BASE_URL ?? "");

function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function buildProjectArtifactPath(artifact: Pick<ProjectArtifactView, "projectId" | "id">): string {
  return `/api/project-artifacts/${encodeSegment(artifact.projectId)}/${encodeSegment(artifact.id)}/file`;
}

export function buildProjectArtifactDownloadPath(artifact: Pick<ProjectArtifactView, "projectId" | "id">): string {
  return `${buildProjectArtifactPath(artifact)}?download=1`;
}

export function buildProjectArtifactAccess(artifact: Pick<ProjectArtifactView, "projectId" | "id">) {
  const path = buildProjectArtifactPath(artifact);
  const downloadPath = buildProjectArtifactDownloadPath(artifact);
  return {
    path,
    downloadPath,
    internalUrl: internalBaseUrl ? `${internalBaseUrl}${path}` : path,
    internalDownloadUrl: internalBaseUrl ? `${internalBaseUrl}${downloadPath}` : downloadPath,
    publicUrl: publicBaseUrl ? `${publicBaseUrl}${path}` : null,
    publicDownloadUrl: publicBaseUrl ? `${publicBaseUrl}${downloadPath}` : null
  };
}

export function decorateProjectArtifactWithAccess<T extends ProjectArtifactView>(artifact: T): T & {
  access: ReturnType<typeof buildProjectArtifactAccess>;
} {
  return {
    ...artifact,
    access: buildProjectArtifactAccess(artifact)
  };
}

export function getProjectArtifactUserDownloadUrl(artifact: Pick<ProjectArtifactView, "projectId" | "id">): string {
  const access = buildProjectArtifactAccess(artifact);
  return access.publicDownloadUrl ?? access.downloadPath;
}

export function formatProjectArtifactAccessLine(artifact: ProjectArtifactView): string {
  const parts = [
    artifact.title,
    `file=${artifact.fileName}`,
    `ref=${artifact.id}`,
    `download=${getProjectArtifactUserDownloadUrl(artifact)}`
  ];
  return parts.join(" | ");
}
