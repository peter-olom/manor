import { normalizeString, normalizeStringArray } from "./codex-harness-helpers.js";
import { getActiveManorSettings } from "./manor-settings-runtime.js";
import type { ButlerStateStore } from "./state-store.js";
import { formatVisionInspection, type VisionInspectionService } from "./vision-inspection.js";

export async function handleHarnessVisionAction(input: {
  action: string;
  params: Record<string, unknown>;
  threadId: string;
  store: ButlerStateStore;
  visionInspection: VisionInspectionService;
  allowedImageReferenceIds: string[];
}): Promise<{ text: string; data: Record<string, unknown> } | null> {
  if (input.action !== "vision.inspect") return null;
  const imageReferenceIds = normalizeStringArray(input.params.imageReferenceIds);
  const question = normalizeString(input.params.question);
  if (imageReferenceIds.length === 0) throw new Error("vision.inspect requires at least one image reference id");
  if (!question) throw new Error("vision.inspect requires a focused question");
  const allowed = new Set(input.allowedImageReferenceIds);
  const denied = imageReferenceIds.filter((id) => !allowed.has(id));
  if (denied.length > 0) throw new Error("vision.inspect can only access image attachments registered to this job");
  let inspection;
  try {
    inspection = await input.visionInspection.inspect({ imageReferenceIds, question });
  } catch (error) {
    if (getActiveManorSettings().vision.unavailableBehavior === "block") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    input.store.addEvent(input.threadId, "harness.vision.unavailable", reason);
    return { text: `Vision inspection was unavailable: ${reason}\n\nContinue without image-dependent claims.`, data: { inspection: null, unavailable: true } };
  }
  input.store.addEvent(input.threadId, "harness.vision.inspected", `${inspection.model.provider}/${inspection.model.id} inspected ${inspection.images.length} image attachment${inspection.images.length === 1 ? "" : "s"}.`);
  return { text: formatVisionInspection(inspection), data: { inspection } };
}
