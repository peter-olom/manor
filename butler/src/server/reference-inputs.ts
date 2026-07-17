import type { FileReferenceStore } from "./file-store.js";
import type { ImageReferenceStore, WorkerInputItem } from "./image-store.js";
import type { PairComposerInputItem } from "../shared/pairing.js";

const DEFAULT_IMAGE_PROMPT = "Use the attached reference image for this request.";
const DEFAULT_IMAGES_PROMPT = "Use the attached reference images for this request.";
const DEFAULT_FILE_PROMPT = "Use the attached reference file for this request.";
const DEFAULT_FILES_PROMPT = "Use the attached reference files for this request.";
const DEFAULT_MIXED_PROMPT = "Use the attached reference files and images for this request.";

function selectDefaultLead(imageCount: number, fileCount: number): string {
  if (imageCount > 0 && fileCount > 0) {
    return DEFAULT_MIXED_PROMPT;
  }

  if (imageCount > 0) {
    return imageCount === 1 ? DEFAULT_IMAGE_PROMPT : DEFAULT_IMAGES_PROMPT;
  }

  if (fileCount > 0) {
    return fileCount === 1 ? DEFAULT_FILE_PROMPT : DEFAULT_FILES_PROMPT;
  }

  return "";
}

export function buildReferencePromptText(input: {
  text: string;
  imageStore: ImageReferenceStore;
  imageReferenceIds: string[];
  fileStore: FileReferenceStore;
  fileReferenceIds: string[];
  includeIds?: boolean;
  includeFilePaths?: boolean;
}): string {
  const trimmedText = input.text.trim();
  const images = input.imageStore.resolveViews(input.imageReferenceIds);
  const files = input.fileStore.resolveViews(input.fileReferenceIds);

  if (images.length === 0 && files.length === 0) {
    return trimmedText;
  }

  const lead = trimmedText || selectDefaultLead(images.length, files.length);
  const sections: string[] = [];
  if (images.length > 0) {
    sections.push(input.includeIds ? "Stored reference images:" : "Attached reference images:");
    if (input.includeIds) {
      sections.push("Pass these ids in imageReferenceIds when delegating to a Worker.");
    }
    for (const image of images) {
      sections.push(input.includeIds ? `- ${image.id} | ${image.name}` : `- ${image.name}`);
    }
  }

  if (files.length > 0) {
    sections.push(input.includeIds ? "Stored reference files:" : "Attached reference files:");
    if (input.includeIds) {
      sections.push("Pass these ids in fileReferenceIds when delegating to a Worker.");
    }
    sections.push("Use shell tools to inspect these files when needed. Use the URL if local path access fails.");
    for (const file of files) {
      const filePath = (input.fileStore.getFilePath(file.id) ?? file.url).trim();
      const sharedUrl = `http://butler:8080${file.url}?download=1`;
      if (input.includeFilePaths) {
        sections.push(
          input.includeIds
            ? `- ${file.id} | ${file.name} | path: ${filePath} | download: [file](${file.url}) | fetch: ${sharedUrl}`
            : `- ${file.name} | ${filePath} | ${sharedUrl}`
        );
      } else {
        sections.push(input.includeIds ? `- ${file.id} | ${file.name} | download: [file](${file.url})` : `- ${file.name}`);
      }
    }
  }

  if (!lead) {
    return sections.join("\n");
  }

  return `${lead}\n\n${sections.join("\n")}`;
}

export function buildComposerInputItemsPrompt(inputItems: unknown[]): string {
  const lines: string[] = [];

  for (const item of normalizeComposerInputItems(inputItems)) {
    if (item.type === "skill") lines.push(`- skill: ${item.name} (${item.path ?? item.id ?? item.name})`);
    if (item.type === "file") lines.push(`- file: ${item.name} (${item.path})`);
    if (item.type === "mention") lines.push(`- app: ${item.name ?? item.path} (${item.path})`);
  }

  if (lines.length === 0) {
    return "";
  }

  return ["Selected composer context:", "Use these selected Worker context items when delegating or reasoning about the operator request.", ...lines].join("\n");
}

export function normalizeComposerInputItems(inputItems: unknown): PairComposerInputItem[] {
  if (!Array.isArray(inputItems)) return [];
  const normalized: PairComposerInputItem[] = [];
  const seen = new Set<string>();
  for (const item of inputItems.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const itemPath = typeof record.path === "string" ? record.path.trim().slice(0, 2_000) : "";
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 200) : "";
    let normalizedItem: PairComposerInputItem | null = null;
    if (record.type === "file" && name && itemPath) normalizedItem = { type: "file", name, path: itemPath };
    if (record.type === "skill" && name) {
      const id = typeof record.id === "string" ? record.id.trim().slice(0, 200) : "";
      const environment = record.environment === "butler-pi" || record.environment === "worker-pi"
        ? record.environment
        : undefined;
      if (itemPath || id) normalizedItem = { type: "skill", name, ...(itemPath ? { path: itemPath } : {}), ...(id ? { id } : {}), ...(environment ? { environment } : {}) };
    }
    if (record.type === "mention" && itemPath) normalizedItem = { type: "mention", ...(name ? { name } : {}), path: itemPath };
    if (!normalizedItem) continue;
    const key = `${normalizedItem.type}:${"path" in normalizedItem ? normalizedItem.path : "id" in normalizedItem ? normalizedItem.id : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(normalizedItem);
  }
  return normalized;
}

export function buildWorkerInputWithReferences(input: {
  text: string;
  imageStore: ImageReferenceStore;
  imageReferenceIds: string[];
  fileStore: FileReferenceStore;
  fileReferenceIds: string[];
  extraInputItems?: unknown[];
}): WorkerInputItem[] {
  const promptText = buildReferencePromptText({
    text: input.text,
    imageStore: input.imageStore,
    imageReferenceIds: input.imageReferenceIds,
    fileStore: input.fileStore,
    fileReferenceIds: input.fileReferenceIds,
    includeIds: true,
    includeFilePaths: true
  });
  const images = input.imageStore.resolveViews(input.imageReferenceIds);
  const output: WorkerInputItem[] = [];

  if (promptText) {
    output.push({ type: "text", text: promptText });
  }

  for (const image of images) {
    output.push({
      type: "localImage",
      path: input.imageStore.getFilePath(image.id) ?? "",
      mimeType: image.mimeType
    });
  }

  for (const item of input.extraInputItems ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type === "skill" && typeof record.name === "string" && typeof record.path === "string") {
      output.push({ type: "skill", name: record.name, path: record.path });
    }

    if (record.type === "mention" && typeof record.path === "string") {
      output.push({
        type: "mention",
        path: record.path,
        ...(typeof record.name === "string" ? { name: record.name } : {})
      });
    }
  }

  const normalized = output.filter((item) => {
    if (item.type === "text") {
      return item.text.trim().length > 0;
    }
    if (item.type === "skill" || item.type === "mention" || item.type === "localImage") {
      return item.path.trim().length > 0;
    }
    return true;
  });

  if (normalized.length === 0) {
    throw new Error("A message must include text or at least one attachment");
  }

  return normalized;
}

/** @deprecated Use buildWorkerInputWithReferences for provider-neutral worker input. */
export const buildCodexInputWithReferences = buildWorkerInputWithReferences;
