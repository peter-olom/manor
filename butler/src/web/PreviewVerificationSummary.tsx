import { Fragment, useState } from "react";

import { probeResourceAvailability, triggerResourceDownload } from "./api";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "./icons";
import type { PreviewMedia, PreviewProofRecord, PreviewVerification, PreviewVerificationArtifact } from "./types";
import {
  describeArtifactAvailability,
  formatVerificationSummary,
  formatVerificationTimestamp,
  isBrowserOpenableProofArtifact,
  selectReviewableProofArtifacts
} from "./utils";

function extensionLabel(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "md":
      return "Markdown";
    case "pdf":
      return "PDF";
    case "csv":
      return "CSV";
    case "html":
    case "htm":
      return "HTML";
    case "json":
    case "jsonl":
      return "JSON";
    case "log":
      return "log";
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
      return "image";
    default:
      return extension ? extension.toUpperCase() : "file";
  }
}

function formatProofArtifactSummary(artifacts: PreviewVerificationArtifact[]): string {
  const parts = [
    artifacts.some((artifact) => artifact.kind === "screenshot") ? "Screenshot" : null,
    artifacts.some((artifact) => artifact.kind === "video") ? "Video" : null,
    ...artifacts
      .filter((artifact) => artifact.kind === "file")
      .map((artifact) => extensionLabel(artifact.fileName)),
    artifacts.some((artifact) => artifact.kind === "manifest" || artifact.kind === "trace" || artifact.kind === "html")
      ? "Debug artifacts"
      : null
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return "Open proof";
  }
  return [...new Set(parts)].join(" + ");
}

function proofKindLabel(verification: PreviewVerification, artifacts: PreviewVerificationArtifact[]): { label: string; className: string } {
  if (verification.failureKind !== "none") {
    return { label: "Signal", className: "is-signal" };
  }
  if (artifacts.some((artifact) => artifact.kind === "screenshot" || artifact.kind === "video")) {
    return { label: "Execution proof", className: "is-evidence" };
  }
  if (artifacts.some((artifact) => artifact.kind === "file")) {
    return { label: "Deliverable", className: "is-deliverable" };
  }
  return { label: "Artifact", className: "is-artifact" };
}

function artifactHref(artifact: PreviewVerificationArtifact, downloadKind: boolean): string | null {
  return downloadKind ? artifact.downloadUrl ?? artifact.url : artifact.url ?? artifact.downloadUrl;
}

function formatOpenFileLabel(artifact: PreviewVerificationArtifact): string {
  return `Open ${extensionLabel(artifact.fileName)}`;
}

function artifactSectionLabel(artifact: PreviewVerificationArtifact): "Evidence" | "Deliverables" | "Debug artifacts" {
  if (artifact.kind === "screenshot" || artifact.kind === "video") {
    return "Evidence";
  }
  if (artifact.kind === "file") {
    return "Deliverables";
  }
  return "Debug artifacts";
}

function groupProofArtifacts(artifacts: PreviewVerificationArtifact[]): { label: string; artifacts: PreviewVerificationArtifact[] }[] {
  const sections = new Map<string, PreviewVerificationArtifact[]>();
  for (const artifact of artifacts) {
    const label = artifactSectionLabel(artifact);
    sections.set(label, [...(sections.get(label) ?? []), artifact]);
  }
  return ["Evidence", "Deliverables", "Debug artifacts"]
    .map((label) => ({ label, artifacts: sections.get(label) ?? [] }))
    .filter((section) => section.artifacts.length > 0);
}

function formatProofArtifactLinkLabel(artifact: PreviewVerificationArtifact): string {
  if (artifact.kind === "screenshot") {
    return "Open screenshot proof";
  }
  if (artifact.kind === "video") {
    return "Open video proof";
  }
  if (artifact.kind === "file") {
    return `Download ${extensionLabel(artifact.fileName)}`;
  }
  if (artifact.kind === "trace") {
    return "Download trace";
  }
  if (artifact.kind === "html") {
    return "Download rendered HTML";
  }
  if (artifact.kind === "manifest") {
    return "Download manifest";
  }
  return artifact.label;
}

export function PreviewVerificationSummary({
  proof,
  verification,
  onPreviewArtifact,
  onResourceUnavailable,
  onDeleteProof
}: {
  proof?: PreviewProofRecord | null;
  verification: PreviewVerification;
  onPreviewArtifact?: (media: PreviewMedia) => void;
  onResourceUnavailable?: (message: string) => void;
  onDeleteProof?: (proofId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const primaryArtifacts = selectReviewableProofArtifacts(verification);
  const artifactSections = groupProofArtifacts(primaryArtifacts);
  const proofKind = proofKindLabel(verification, primaryArtifacts);
  const issueLines = [
    verification.failureKind !== "none" ? `Signal: ${verification.failureKind}` : null,
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
  const availableArtifactCount = primaryArtifacts.filter((artifact) => artifact.availability === "available").length;
  const compactSummary = issueLines[0] ?? (availableArtifactCount > 0 ? formatProofArtifactSummary(primaryArtifacts) : "Open proof");
  const proofTimestamp = formatVerificationTimestamp(proof?.createdAt ?? verification.checkedAt);

  return (
    <div className="preview-verification-summary">
      <div className="preview-verification-trigger-row">
        <button
          className="preview-verification-trigger"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="preview-verification-summary-head">
            <span className="preview-verification-status">Recorded</span>
            <span className={`preview-verification-kind ${proofKind.className}`}>{proofKind.label}</span>
            <span className="preview-verification-meta">{formatVerificationSummary(verification)}</span>
            <span className="preview-verification-stamp">{proofTimestamp}</span>
          </span>
          <span className="preview-verification-trigger-summary">{compactSummary}</span>
        </button>
        <div className="preview-verification-actions">
          {proof && onDeleteProof ? (
            <button
              className="panel-action panel-action-icon panel-action-icon-danger preview-verification-delete"
              type="button"
              aria-label="Delete proof"
              title="Delete proof"
              onClick={() => onDeleteProof(proof.id)}
            >
              <TrashIcon />
            </button>
          ) : (
            <span className="preview-verification-delete-spacer" aria-hidden="true" />
          )}
          <button
            className="preview-verification-toggle"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="preview-verification-trigger-action">
              {open ? "Hide proof" : "Open proof"}
              <span className="preview-verification-trigger-icon" aria-hidden="true">
                {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
              </span>
            </span>
          </button>
        </div>
      </div>
      {open ? (
        <div className="preview-verification-body">
          {issueLines.length > 0 ? (
            <div className="preview-verification-issues">
              {issueLines.map((line, index) => (
                <div key={`${verification.runId}-issue-${index}`} className="preview-verification-issue">
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {artifactSections.length > 0 ? (
            <div className="preview-verification-artifact-sections">
              {artifactSections.map((section) => (
                <div key={`${verification.runId}-${section.label}`} className="preview-verification-artifact-section">
                  {artifactSections.length > 1 ? <div className="preview-verification-section-label">{section.label}</div> : null}
                  <div className="preview-verification-links">
                    {section.artifacts.map((artifact) => {
                      const downloadKind =
                        artifact.kind === "manifest" || artifact.kind === "trace" || artifact.kind === "html" || artifact.kind === "file" || artifact.kind === "other";
                      const href = artifactHref(artifact, downloadKind);
                      const openFileHref = isBrowserOpenableProofArtifact(artifact) ? artifact.url : null;
                      const previewKind = artifact.kind === "screenshot" ? "image" : artifact.kind === "video" ? "video" : null;
                      const availability = describeArtifactAvailability(artifact);
                      if (!availability.available || (!href && !openFileHref)) {
                        return (
                          <span
                            key={`${verification.runId}-${artifact.kind}-${artifact.fileName}`}
                            className="preview-verification-link-disabled"
                            title={availability.detail ?? "This proof artifact is not downloadable."}
                          >
                            {availability.available ? `${formatProofArtifactLinkLabel(artifact)} unavailable` : availability.label}
                          </span>
                        );
                      }

                      return (
                        <Fragment key={`${verification.runId}-${artifact.kind}-${artifact.fileName}`}>
                          {openFileHref ? (
                            <a
                              key={`${verification.runId}-${artifact.kind}-${artifact.fileName}-open`}
                              href={openFileHref}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {formatOpenFileLabel(artifact)}
                            </a>
                          ) : null}
                          {href ? (
                            <a
                              key={`${verification.runId}-${artifact.kind}-${artifact.fileName}-primary`}
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
                              {formatProofArtifactLinkLabel(artifact)}
                            </a>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
