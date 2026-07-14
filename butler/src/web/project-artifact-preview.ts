import { resolveReferencePreviewKind, type ReferencePreviewKind } from "../shared/references";

export type ProjectArtifactPreviewTarget = {
  projectId: string;
  artifactId: string;
  openUrl: string;
  previewUrl: string;
  downloadUrl: string;
  detailUrl: string;
};

export type ProjectArtifactPreview = {
  id: string;
  name: string;
  mimeType: string;
  previewKind: ReferencePreviewKind;
  previewUrl: string;
  downloadUrl: string;
};

type ProjectArtifactFileInput = {
  id: string;
  name: string;
  mimeType: string;
  url: string;
};

function currentOrigin(): string {
  return typeof window === "undefined" ? "http://manor.local" : window.location.origin;
}

function parseProjectArtifactUrl(value: string, acceptedSearch: "open" | "download"): URL | null {
  try {
    const origin = currentOrigin();
    const url = new URL(value, origin);
    if (url.origin !== origin || url.hash) return null;
    const isDownload = url.searchParams.get("download") === "1" && [...url.searchParams.keys()].length === 1;
    if (acceptedSearch === "download" ? !isDownload : url.search) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 5 || segments[0] !== "api" || segments[1] !== "project-artifacts" || segments[4] !== "file") return null;
    const projectId = decodeURIComponent(segments[2] ?? "");
    const artifactId = decodeURIComponent(segments[3] ?? "");
    if (!projectId || !artifactId || projectId.includes("/") || artifactId.includes("/")) return null;
    return url;
  } catch {
    return null;
  }
}

export function parseProjectArtifactPreviewTarget(value: string): ProjectArtifactPreviewTarget | null {
  const url = parseProjectArtifactUrl(value, "open");
  if (!url) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = decodeURIComponent(segments[2] ?? "");
  const artifactId = decodeURIComponent(segments[3] ?? "");
  return {
    projectId,
    artifactId,
    openUrl: url.pathname,
    previewUrl: `${url.pathname}?preview=1`,
    downloadUrl: `${url.pathname}?download=1`,
    detailUrl: `/api/project-artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}`
  };
}

export function isProjectArtifactDownloadUrl(value: string): boolean {
  return parseProjectArtifactUrl(value, "download") !== null;
}

export function buildProjectArtifactPreview(input: ProjectArtifactFileInput): ProjectArtifactPreview | null {
  const target = parseProjectArtifactPreviewTarget(input.url);
  const previewKind = resolveReferencePreviewKind(input.name, input.mimeType);
  if (!target || !previewKind) return null;
  return {
    id: input.id,
    name: input.name,
    mimeType: input.mimeType,
    previewKind,
    previewUrl: target.previewUrl,
    downloadUrl: target.downloadUrl
  };
}
