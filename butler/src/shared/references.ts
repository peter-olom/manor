export type ReferenceLibraryKind = "image" | "file";

export type ReferenceLibraryItem = {
  id: string;
  kind: ReferenceLibraryKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
  downloadUrl: string;
  sourceReferenceId?: string;
  version: number;
  hasChildren: boolean;
};

export type ReferenceLibraryResponse = {
  items: ReferenceLibraryItem[];
};
