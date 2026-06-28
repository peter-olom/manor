import type { RuntimeCleanupTaskView } from "./types.js";


export type ThreadDeleteContext = {
  threadId: string;
  cwd: string | null;
  threadCreatedAt: number | null;
  stacks: RuntimeCleanupTaskView["stacks"];
  previews: RuntimeCleanupTaskView["previews"];
  services: RuntimeCleanupTaskView["services"];
  proofArtifactPaths?: string[];
};

export type ComposerSuggestionInputItem =
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name?: string;
      path: string;
    };

export type ComposerSuggestion = {
  id: string;
  kind: "file" | "directory" | "skill" | "app" | "plugin" | "agent";
  label: string;
  detail: string | null;
  insertText: string;
  inputItem?: ComposerSuggestionInputItem;
};

export type FsDirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};
