import { useCallback, useState } from "react";

import { getProjectArtifactPreviewMetadata } from "./api";
import { FilePreviewModal, type FilePreviewMedia } from "./FilePreviewModal";
import { buildProjectArtifactPreview, type ProjectArtifactPreview, type ProjectArtifactPreviewTarget } from "./project-artifact-preview";

export function useProjectArtifactPreview(onError: (error: string) => void) {
  const [filePreview, setFilePreview] = useState<FilePreviewMedia | null>(null);
  const openProjectArtifactFile = useCallback((preview: ProjectArtifactPreview) => {
    onError("");
    setFilePreview(preview);
  }, [onError]);
  const openProjectArtifact = useCallback((target: ProjectArtifactPreviewTarget) => {
    onError("");
    void getProjectArtifactPreviewMetadata(target.detailUrl)
      .then((artifact) => {
        const preview = buildProjectArtifactPreview({
          id: artifact.id,
          name: artifact.fileName,
          mimeType: artifact.contentType,
          url: target.openUrl
        });
        if (!preview) {
          onError("This file type cannot be previewed here. Use Download instead.");
          return;
        }
        setFilePreview(preview);
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [onError]);
  const dialog = filePreview ? (
    <FilePreviewModal
      media={filePreview}
      attachTargetLabel={null}
      onAttached={() => undefined}
      onClose={() => setFilePreview(null)}
      showErrorToast={(error) => onError(error instanceof Error ? error.message : String(error))}
    />
  ) : null;
  return { openProjectArtifact, openProjectArtifactFile, dialog };
}
