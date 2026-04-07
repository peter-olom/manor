import path from "node:path";

import type { PreviewVerificationArtifactView, PreviewVerificationView } from "./types.js";

const artifactsRootDir = path.resolve(process.env.MANOR_ARTIFACTS_DIR ?? "/artifacts");
const artifactsPublicBasePath = process.env.MANOR_ARTIFACTS_PUBLIC_BASE_PATH ?? "/api/artifacts";

function toArtifactPublicUrl(filePath: string): string | null {
  if (!filePath) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== artifactsRootDir && !resolvedPath.startsWith(`${artifactsRootDir}${path.sep}`)) {
    return null;
  }

  const relativePath = path.relative(artifactsRootDir, resolvedPath).split(path.sep).map(encodeURIComponent).join("/");
  return `${artifactsPublicBasePath}/${relativePath}`;
}

function decorateArtifact(artifact: PreviewVerificationArtifactView): PreviewVerificationArtifactView {
  return {
    ...artifact,
    url: artifact.url ?? toArtifactPublicUrl(artifact.filePath)
  };
}

export function decoratePreviewVerification(verification: PreviewVerificationView): PreviewVerificationView {
  return {
    ...verification,
    artifacts: Array.isArray(verification.artifacts) ? verification.artifacts.map((artifact) => decorateArtifact(artifact)) : []
  };
}

