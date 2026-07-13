import type { ReferenceMetadata, ReferenceOrigin } from "../shared/references.js";

const REFERENCE_ORIGINS = new Set<ReferenceOrigin>([
  "butler-upload",
  "file-explorer",
  "image-annotation",
  "pdf-annotation",
  "worker-output",
  "preview-annotation"
]);

function normalizedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

export function normalizeReferenceMetadata(value: unknown): ReferenceMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const origin = normalizedText(input.origin, 40);
  const projectId = normalizedText(input.projectId, 160);
  const projectLabel = normalizedText(input.projectLabel, 220);
  const sessionId = normalizedText(input.sessionId, 160);
  const sessionTitle = normalizedText(input.sessionTitle, 220);
  const metadata: ReferenceMetadata = {
    ...(projectId ? { projectId } : {}),
    ...(projectLabel ? { projectLabel } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(origin && REFERENCE_ORIGINS.has(origin as ReferenceOrigin) ? { origin: origin as ReferenceOrigin } : {})
  };
  return Object.values(metadata).some(Boolean) ? metadata : undefined;
}

export function deriveReferenceMetadata(
  source: ReferenceMetadata | undefined,
  input: ReferenceMetadata | undefined
): ReferenceMetadata | undefined {
  const inherited = normalizeReferenceMetadata(source);
  const supplied = normalizeReferenceMetadata(input);
  return normalizeReferenceMetadata({
    projectId: inherited?.projectId ?? supplied?.projectId,
    projectLabel: inherited?.projectLabel ?? supplied?.projectLabel,
    sessionId: inherited?.sessionId ?? supplied?.sessionId,
    sessionTitle: inherited?.sessionTitle ?? supplied?.sessionTitle,
    origin: supplied?.origin ?? inherited?.origin
  });
}
