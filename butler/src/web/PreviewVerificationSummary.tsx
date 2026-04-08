import { probeResourceAvailability, triggerResourceDownload } from "./api";
import type { PreviewMedia, PreviewVerification, PreviewVerificationArtifact } from "./types";
import {
  describeArtifactAvailability,
  findVerificationArtifact,
  formatVerificationSummary
} from "./utils";

export function PreviewVerificationSummary({
  verification,
  onPreviewArtifact,
  onResourceUnavailable
}: {
  verification: PreviewVerification;
  onPreviewArtifact?: (media: PreviewMedia) => void;
  onResourceUnavailable?: (message: string) => void;
}) {
  const primaryArtifacts = ["screenshot", "video", "manifest", "trace"]
    .map((kind) => findVerificationArtifact(verification, kind as PreviewVerificationArtifact["kind"]))
    .filter((artifact): artifact is PreviewVerificationArtifact => Boolean(artifact));
  const issueLines = [
    verification.failureKind !== "none" ? `Failure: ${verification.failureKind}` : null,
    verification.error,
    verification.readiness.loginRedirectDetected ? "Redirected to login during verification." : null,
    ...verification.readiness.htmlErrorSignals,
    ...verification.phases
      .filter((phase) => phase.status === "failed")
      .map((phase) => `${phase.label}: ${phase.message || "failed"}`),
    ...verification.artifacts
      .filter((artifact) => artifact.availability !== "available")
      .slice(0, 2)
      .map((artifact) => describeArtifactAvailability(artifact).detail)
      .filter((detail): detail is string => Boolean(detail)),
    ...verification.pageErrors,
    ...verification.failedRequests.slice(0, 2).map((request) => `${request.method} ${request.url}${request.errorText ? ` • ${request.errorText}` : ""}`)
  ].slice(0, 3);

  return (
    <div className={`preview-verification-summary${verification.ok ? " is-passed" : " is-failed"}`}>
      <div className="preview-verification-summary-head">
        <span className="preview-verification-status">{verification.ok ? "Passed" : "Failed"}</span>
        <span className="preview-verification-meta">{formatVerificationSummary(verification)}</span>
      </div>
      {issueLines.length > 0 ? (
        <div className="preview-verification-issues">
          {issueLines.map((line, index) => (
            <div key={`${verification.runId}-issue-${index}`} className="preview-verification-issue">
              {line}
            </div>
          ))}
        </div>
      ) : null}
      {primaryArtifacts.length > 0 ? (
        <div className="preview-verification-links">
          {primaryArtifacts.map((artifact) => {
            const downloadKind =
              artifact.kind === "manifest" || artifact.kind === "trace" || artifact.kind === "html";
            const href = downloadKind ? artifact.downloadUrl ?? artifact.url ?? undefined : artifact.url ?? undefined;
            const previewKind = artifact.kind === "screenshot" ? "image" : artifact.kind === "video" ? "video" : null;
            const availability = describeArtifactAvailability(artifact);
            if (!availability.available) {
              return (
                <span
                  key={`${verification.runId}-${artifact.kind}`}
                  className="preview-verification-link-disabled"
                  title={availability.detail ?? undefined}
                >
                  {availability.label}
                </span>
              );
            }

            return (
              <a
                key={`${verification.runId}-${artifact.kind}`}
                href={href}
                target={downloadKind || previewKind ? undefined : "_blank"}
                rel={downloadKind || previewKind ? undefined : "noreferrer"}
                download={downloadKind ? "" : undefined}
                onClick={
                  downloadKind || previewKind
                    ? (event) => {
                        event.preventDefault();
                        void (async () => {
                          if (previewKind && onPreviewArtifact && (artifact.url || artifact.downloadUrl)) {
                            const resourceHref = artifact.url ?? artifact.downloadUrl ?? "";
                            const availabilityCheck = await probeResourceAvailability(resourceHref);
                            if (!availabilityCheck.ok) {
                              onResourceUnavailable?.(availabilityCheck.message || "The proof file could not be opened.");
                              return;
                            }

                            onPreviewArtifact({
                              name: artifact.fileName || artifact.label,
                              url: resourceHref,
                              kind: previewKind,
                              downloadUrl: artifact.downloadUrl ?? artifact.url
                            });
                            return;
                          }

                          if (downloadKind && href) {
                            try {
                              await triggerResourceDownload(href);
                            } catch (error) {
                              onResourceUnavailable?.(
                                error instanceof Error ? error.message : "The file could not be downloaded."
                              );
                            }
                          }
                        })();
                      }
                    : undefined
                }
              >
                {downloadKind
                  ? `Download ${artifact.label.toLowerCase()}`
                  : artifact.kind === "screenshot"
                    ? "Open screenshot"
                    : artifact.kind === "video"
                      ? "Open video"
                      : artifact.label}
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
