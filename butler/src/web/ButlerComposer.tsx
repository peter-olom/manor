import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { AttachmentIcon, CloseIcon, SendIcon } from "./icons";
import type { ButlerThinkingLevel, FileReference, ModelOption, PreviewableImage } from "./types";
import {
  DRAFT_PERSIST_DELAY_MS,
  isFileDrag,
  readStoredValue,
  resizeComposerTextarea,
  writeStoredValue
} from "./utils";

const FILE_UPLOAD_ACCEPT = ".pdf,.ppt,.pptx,.xls,.xlsx,.doc,.docx,.txt,.csv,.json,.md,.zip,image/*,*/*";

function appendDraftText(current: string, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return current;
  }

  const trimmedCurrent = current.trim();
  return trimmedCurrent ? `${trimmedCurrent}\n\n${trimmedAddition}` : trimmedAddition;
}

export const ButlerComposer = memo(function ButlerComposer({
  draftStorageKey,
  draftPrefill,
  modelKey,
  thinkingLevel,
  availableModels,
  availableThinkingLevels,
  attachments,
  uploadingAttachments,
  onFilesSelected,
  onRemoveAttachment,
  onPreviewImage,
  onSend,
  onModelChange,
  onThinkingLevelChange,
  onDraftPrefillApplied
}: {
  draftStorageKey: string;
  draftPrefill?: { id: string; text: string } | null;
  modelKey: string;
  thinkingLevel: ButlerThinkingLevel;
  availableModels: ModelOption[];
  availableThinkingLevels: ButlerThinkingLevel[];
  attachments: FileReference[];
  uploadingAttachments: number;
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewImage: (image: PreviewableImage) => void;
  onSend: (text: string) => Promise<void>;
  onModelChange: (modelKey: string) => void;
  onThinkingLevelChange: (thinkingLevel: ButlerThinkingLevel) => void;
  onDraftPrefillApplied?: (prefillId: string) => void;
}) {
  const [draft, setDraft] = useState(() => readStoredValue(draftStorageKey));
  const [dragActive, setDragActive] = useState(false);
  const persistTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastAppliedPrefillIdRef = useRef<string | null>(null);

  useEffect(() => {
    setDraft(readStoredValue(draftStorageKey));
  }, [draftStorageKey]);

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      writeStoredValue(draftStorageKey, draft);
      persistTimerRef.current = null;
    }, DRAFT_PERSIST_DELAY_MS);

    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [draft, draftStorageKey]);

  useLayoutEffect(() => {
    resizeComposerTextarea(textareaRef.current);
  }, [draft]);

  useEffect(() => {
    if (!draftPrefill || lastAppliedPrefillIdRef.current === draftPrefill.id) {
      return;
    }

    lastAppliedPrefillIdRef.current = draftPrefill.id;
    setDraft((current) => {
      const next = appendDraftText(current, draftPrefill.text);
      writeStoredValue(draftStorageKey, next);
      return next;
    });
    onDraftPrefillApplied?.(draftPrefill.id);
  }, [draftPrefill, draftStorageKey, onDraftPrefillApplied]);

  async function handleSend() {
    const text = draft.trim();
    if (!text && attachments.length === 0) {
      return;
    }

    setDraft("");
    writeStoredValue(draftStorageKey, "");

    try {
      await onSend(text);
    } catch (error) {
      setDraft((current) => (current.trim().length === 0 ? text : current));
      throw error;
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    void handleSend();
  }

  function handleFileSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (files && files.length > 0) {
      onFilesSelected(files);
    }
    event.target.value = "";
  }

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && uploadingAttachments === 0;

  return (
    <div
      className={`composer${dragActive ? " is-drop-target" : ""}`}
      onDragEnter={(event) => {
        if (isFileDrag(event)) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(event) => {
        if (isFileDrag(event)) {
          event.preventDefault();
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragActive(false);
        if (!isFileDrag(event)) {
          return;
        }
        onFilesSelected(event.dataTransfer.files);
      }}
    >
      <input ref={fileInputRef} type="file" accept={FILE_UPLOAD_ACCEPT} multiple hidden onChange={handleFileSelection} />
      {attachments.length > 0 || uploadingAttachments > 0 ? (
        <div>
          {attachments.length > 0 ? (
            <div className="composer-attachments composer-attachments-static">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="composer-attachment">
                  {attachment.mimeType.startsWith("image/") ? (
                    <button
                      className="composer-attachment-preview"
                      type="button"
                      onClick={() => onPreviewImage({ id: attachment.id, name: attachment.name, url: attachment.url })}
                      aria-label={`Preview ${attachment.name}`}
                      title={attachment.name}
                    >
                      <img src={attachment.url} alt={attachment.name} className="composer-attachment-thumb" />
                    </button>
                  ) : (
                    <button className="composer-attachment-preview" type="button" onClick={() => window.open(attachment.url, "_blank")} aria-label={`Open ${attachment.name}`} title={attachment.name}>
                      <span className="composer-attachment-name">File</span>
                    </button>
                  )}
                  <div className="composer-attachment-copy">
                    <button
                      className="composer-attachment-name composer-attachment-name-button"
                      type="button"
                      onClick={() =>
                        attachment.mimeType.startsWith("image/")
                          ? onPreviewImage({ id: attachment.id, name: attachment.name, url: attachment.url })
                          : window.open(attachment.url, "_blank")
                      }
                      title={attachment.name}
                    >
                      {attachment.name}
                    </button>
                  </div>
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {uploadingAttachments > 0 ? <div className="composer-uploading">Uploading {uploadingAttachments}…</div> : null}
        </div>
      ) : null}
      <div className="composer-main">
        <textarea
          ref={textareaRef}
          name="butler-chat-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Butler about any run"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={true}
          rows={3}
        />
        <div className="composer-mobile-actions">
          <button
            className="composer-add-image composer-add-image-mobile"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Add file"
            title="Add file"
          >
            <AttachmentIcon />
          </button>
          <button className="composer-send composer-send-mobile" onClick={() => void handleSend()} disabled={!canSend} aria-label="Send message">
            <span className="composer-send-label">Send</span>
            <span className="composer-send-icon">
              <SendIcon />
            </span>
          </button>
        </div>
      </div>
      <div className="composer-footer">
        <div className="composer-inline-controls">
          <select value={modelKey} onChange={(event) => onModelChange(event.target.value)} aria-label="Butler model">
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <select value={thinkingLevel} onChange={(event) => onThinkingLevelChange(event.target.value as ButlerThinkingLevel)} aria-label="Butler reasoning">
            {availableThinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-note">Cmd/Ctrl + Enter sends</div>
        <div className="composer-actions composer-actions-desktop">
          <button className="composer-add-image" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Add file" title="Add file">
            <AttachmentIcon />
          </button>
          <button className="composer-send composer-send-desktop" onClick={() => void handleSend()} disabled={!canSend} aria-label="Send message">
            <span className="composer-send-label">Send</span>
            <span className="composer-send-icon">
              <SendIcon />
            </span>
          </button>
        </div>
      </div>
      {dragActive ? <div className="composer-drop-note">Drop files to attach them</div> : null}
    </div>
  );
});
