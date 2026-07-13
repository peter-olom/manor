import type { FileReferenceStore } from "./file-store.js";
import type { ImageReferenceStore } from "./image-store.js";
import type { ReferenceMutationQueue } from "./reference-mutation-queue.js";
import type { ReferenceLibraryItem, ReferenceLibraryResponse } from "../shared/references.js";

export class ReferenceHasChildrenError extends Error {}

export function listReferenceLibrary(
  imageStore: ImageReferenceStore,
  fileStore: FileReferenceStore
): ReferenceLibraryResponse {
  const images: ReferenceLibraryItem[] = imageStore.list(Number.MAX_SAFE_INTEGER).map((image) => ({
    ...image,
    kind: "image",
    downloadUrl: `${image.url}?download=1`,
    version: image.version ?? 1,
    hasChildren: false
  }));
  const files: ReferenceLibraryItem[] = fileStore.list(Number.MAX_SAFE_INTEGER).map((file) => ({
    ...file,
    kind: "file",
    downloadUrl: file.url,
    version: file.version ?? 1,
    hasChildren: false
  }));
  const items = [...images, ...files];
  const parentIds = new Set(items.flatMap((item) => item.sourceReferenceId ? [item.sourceReferenceId] : []));
  return {
    items: items
      .map((item) => parentIds.has(item.id) ? { ...item, hasChildren: true } : item)
      .sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name))
  };
}

export async function deleteReference(
  referenceId: string,
  imageStore: ImageReferenceStore,
  fileStore: FileReferenceStore,
  mutations: ReferenceMutationQueue
): Promise<boolean> {
  return mutations.run(async () => {
    const matches = listReferenceLibrary(imageStore, fileStore).items.filter((item) => item.id === referenceId);
    if (matches.length > 1) throw new Error("Reference id exists in more than one store");
    const reference = matches[0];
    if (!reference) return false;
    if (reference.hasChildren) throw new ReferenceHasChildrenError("Delete newer versions first");
    return reference.kind === "image" ? imageStore.delete(referenceId) : fileStore.delete(referenceId);
  });
}
