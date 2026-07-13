import path from "node:path";

import { FileReferenceStore, migrateLegacyReferenceStore } from "./file-store.js";
import { ImageReferenceStore } from "./image-store.js";

export { MAX_FILE_BYTES } from "./file-store.js";
export { MAX_IMAGE_BYTES } from "./image-store.js";

export async function loadReferenceStores(input: {
  artifactsDir: string;
  imageReferenceDir: string;
  fileReferenceDir: string;
}): Promise<{ imageStore: ImageReferenceStore; fileStore: FileReferenceStore }> {
  await Promise.all([
    migrateLegacyReferenceStore(path.join(input.artifactsDir, "manor-images"), input.imageReferenceDir),
    migrateLegacyReferenceStore(path.join(input.artifactsDir, "manor-files"), input.fileReferenceDir)
  ]);
  const imageStore = new ImageReferenceStore(input.imageReferenceDir);
  const fileStore = new FileReferenceStore(input.fileReferenceDir);
  await Promise.all([imageStore.load(), fileStore.load()]);
  return { imageStore, fileStore };
}
