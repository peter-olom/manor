import path from "node:path";

import { updateStateStoreArtifactAvailability, type StateStoreInternalAccess } from "./state-store-internals.js";

export function markStateStoreArtifactAvailable(
  access: StateStoreInternalAccess,
  filePath: string,
  availableAt = Date.now()
): boolean {
  const targetPath = path.resolve(filePath);
  const existing = [...access.previewProofs.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .flatMap((proof) => proof.verification.artifacts)
    .find((artifact) => artifact.filePath && path.resolve(artifact.filePath) === targetPath);
  if (
    !existing ||
    existing.availability !== "missing" ||
    (typeof existing.retainedUntilAt === "number" && Number.isFinite(existing.retainedUntilAt) && existing.retainedUntilAt <= availableAt)
  ) {
    return false;
  }
  return updateStateStoreArtifactAvailability(access, filePath, (artifact) =>
    artifact.availability === "missing" ? { ...artifact, availability: "available", expiredAt: null } : artifact
  );
}
