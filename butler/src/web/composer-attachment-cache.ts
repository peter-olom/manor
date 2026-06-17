import type { FileReference } from "./types";

export type ComposerAttachmentUpdate = FileReference[] | ((current: FileReference[]) => FileReference[]);

let butlerComposerAttachments: FileReference[] = [];
const threadComposerAttachments = new Map<string, FileReference[]>();

export function resolveComposerAttachmentUpdate(current: FileReference[], update: ComposerAttachmentUpdate): FileReference[] {
  return [...(typeof update === "function" ? update([...current]) : update)];
}

export function readButlerComposerAttachments(): FileReference[] {
  return [...butlerComposerAttachments];
}

export function updateButlerComposerAttachments(update: ComposerAttachmentUpdate): FileReference[] {
  butlerComposerAttachments = resolveComposerAttachmentUpdate(butlerComposerAttachments, update);
  return readButlerComposerAttachments();
}

export function readThreadComposerAttachments(threadId: string): FileReference[] {
  return [...(threadComposerAttachments.get(threadId) ?? [])];
}

export function updateThreadComposerAttachments(threadId: string, update: ComposerAttachmentUpdate): FileReference[] {
  const next = resolveComposerAttachmentUpdate(threadComposerAttachments.get(threadId) ?? [], update);
  if (next.length === 0) {
    threadComposerAttachments.delete(threadId);
  } else {
    threadComposerAttachments.set(threadId, next);
  }
  return readThreadComposerAttachments(threadId);
}
