import { DownloadIcon, OpenIcon } from "./icons";
import type { PreviewMedia, ProjectArtifact } from "./types";

type ProjectArtifactsPanelProps = {
  artifacts: ProjectArtifact[];
  onPreviewMedia: (media: PreviewMedia) => void;
};

function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatArtifactKind(kind: ProjectArtifact["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function previewKind(contentType: string): "image" | "video" | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return null;
}

export function ProjectArtifactsPanel({ artifacts, onPreviewMedia }: ProjectArtifactsPanelProps) {
  return (
    <div className="thread-artifacts-list">
      {artifacts.length === 0 ? <div className="thread-artifacts-empty">No persisted artifacts for this project.</div> : null}
      {artifacts.map((artifact) => {
        const openUrl = artifact.access.publicUrl ?? artifact.access.path;
        const downloadUrl = artifact.access.publicDownloadUrl ?? artifact.access.downloadPath;
        const mediaKind = previewKind(artifact.contentType);
        return (
          <div key={artifact.id} className="thread-artifact-row">
            {mediaKind ? (
              <button
                className="thread-artifact-preview"
                type="button"
                onClick={() => onPreviewMedia({ name: artifact.fileName, url: openUrl, kind: mediaKind, downloadUrl })}
                aria-label={`Preview ${artifact.fileName}`}
              >
                {mediaKind === "image" ? <img src={openUrl} alt={artifact.fileName} /> : <span>Video</span>}
              </button>
            ) : (
              <a className="thread-artifact-preview thread-artifact-preview-file" href={openUrl} target="_blank" rel="noreferrer">
                {formatArtifactKind(artifact.kind)}
              </a>
            )}
            <div className="thread-artifact-main">
              <span className="thread-artifact-name" title={artifact.title}>{artifact.title}</span>
              <span className="thread-artifact-meta">
                {artifact.fileName} - {formatArtifactKind(artifact.kind)} - {formatArtifactSize(artifact.sizeBytes)}
              </span>
            </div>
            <a className="thread-artifact-icon-action" href={openUrl} target="_blank" rel="noreferrer" aria-label={`Open ${artifact.fileName}`} title="Open">
              <OpenIcon />
            </a>
            <a className="thread-artifact-icon-action" href={downloadUrl} target="_blank" rel="noreferrer" aria-label={`Download ${artifact.fileName}`} title="Download">
              <DownloadIcon />
            </a>
          </div>
        );
      })}
    </div>
  );
}
