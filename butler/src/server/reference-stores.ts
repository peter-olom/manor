import path from "node:path";

import { FileReferenceStore, migrateLegacyReferenceStore } from "./file-store.js";
import { ImageReferenceStore } from "./image-store.js";
import { ReferenceMutationQueue } from "./reference-mutation-queue.js";

export { MAX_FILE_BYTES } from "./file-store.js";
export { MAX_IMAGE_BYTES } from "./image-store.js";

export async function loadReferenceStores(input: {
  artifactsDir: string;
  imageReferenceDir: string;
  fileReferenceDir: string;
}): Promise<{ imageStore: ImageReferenceStore; fileStore: FileReferenceStore; referenceMutations: ReferenceMutationQueue }> {
  await Promise.all([
    migrateLegacyReferenceStore(path.join(input.artifactsDir, "manor-images"), input.imageReferenceDir),
    migrateLegacyReferenceStore(path.join(input.artifactsDir, "manor-files"), input.fileReferenceDir)
  ]);
  const referenceMutations = new ReferenceMutationQueue();
  const imageStore = new ImageReferenceStore(input.imageReferenceDir, "/api/images", referenceMutations);
  const fileStore = new FileReferenceStore(input.fileReferenceDir, "/api/files", referenceMutations);
  await Promise.all([imageStore.load(), fileStore.load()]);
  return { imageStore, fileStore, referenceMutations };
}
