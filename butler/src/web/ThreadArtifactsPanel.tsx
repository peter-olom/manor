import type { PreviewMedia, ThreadArtifact } from "./types";
import { OpenIcon, PinIcon } from "./icons";

type ThreadArtifactsPanelProps = {
  artifacts: ThreadArtifact[];
  promotingArtifactId: string | null;
  onPreviewMedia: (media: PreviewMedia) => void;
  onPromoteArtifact: (artifact: ThreadArtifact) => void;
};

function formatArtifactSize(sizeBytes: number | null): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) {
    return "Size unknown";
  }
  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatArtifactKind(kind: ThreadArtifact["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function ThreadArtifactsPanel({
  artifacts,
  promotingArtifactId,
  onPreviewMedia,
  onPromoteArtifact
}: ThreadArtifactsPanelProps) {
  return (
    <div className="thread-artifacts-list">
      {artifacts.map((artifact) => {
        const canPreview = artifact.previewKind && artifact.url;
        const href = artifact.url ?? artifact.downloadUrl;
        return (
          <div key={artifact.id} className="thread-artifact-row">
            {canPreview ? (
              <button
                className="thread-artifact-preview"
                type="button"
                onClick={() =>
                  onPreviewMedia({
                    name: artifact.fileName,
                    url: artifact.url!,
                    kind: artifact.previewKind!,
                    downloadUrl: artifact.downloadUrl
                  })
                }
                aria-label={`Preview ${artifact.fileName}`}
              >
                {artifact.previewKind === "image" ? (
                  <img src={artifact.url!} alt={artifact.fileName} />
                ) : (
                  <span>{formatArtifactKind(artifact.kind)}</span>
                )}
              </button>
            ) : href ? (
              <a className="thread-artifact-preview thread-artifact-preview-file" href={href} target="_blank" rel="noreferrer">
                {formatArtifactKind(artifact.kind)}
              </a>
            ) : (
              <span className="thread-artifact-preview thread-artifact-preview-file">{formatArtifactKind(artifact.kind)}</span>
            )}
            <div className="thread-artifact-main">
              <span className="thread-artifact-name" title={artifact.fileName}>{artifact.fileName}</span>
              <span className="thread-artifact-meta">
                {formatArtifactKind(artifact.kind)} - {formatArtifactSize(artifact.sizeBytes)}
              </span>
            </div>
            {href ? (
              <a className="thread-artifact-icon-action" href={href} target="_blank" rel="noreferrer" aria-label={`Open ${artifact.fileName}`} title="Open">
                <OpenIcon />
              </a>
            ) : null}
            <button
              className="thread-artifact-icon-action"
              type="button"
              aria-label={artifact.promotedProjectArtifactId ? `${artifact.fileName} kept` : `Keep ${artifact.fileName}`}
              title={artifact.promotedProjectArtifactId ? "Kept" : promotingArtifactId === artifact.id ? "Keeping" : "Keep"}
              disabled={Boolean(artifact.promotedProjectArtifactId) || promotingArtifactId === artifact.id}
              onClick={() => onPromoteArtifact(artifact)}
            >
              <PinIcon pinned={Boolean(artifact.promotedProjectArtifactId)} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
