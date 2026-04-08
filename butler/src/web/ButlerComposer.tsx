import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { AttachmentIcon, CloseIcon, SendIcon } from "./icons";
import type { ButlerThinkingLevel, ImageReference, ModelOption, PreviewableImage } from "./types";
import {
  DRAFT_PERSIST_DELAY_MS,
  isImageDrag,
  readStoredValue,
  resizeComposerTextarea,
  writeStoredValue
} from "./utils";

export const ButlerComposer = memo(function ButlerComposer({
  draftStorageKey,
  modelKey,
  thinkingLevel,
  availableModels,
  availableThinkingLevels,
  images,
  uploadingImages,
  onFilesSelected,
  onRemoveImage,
  onPreviewImage,
  onSend,
  onModelChange,
  onThinkingLevelChange
}: {
  draftStorageKey: string;
  modelKey: string;
  thinkingLevel: ButlerThinkingLevel;
  availableModels: ModelOption[];
  availableThinkingLevels: ButlerThinkingLevel[];
  images: ImageReference[];
  uploadingImages: number;
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveImage: (imageId: string) => void;
  onPreviewImage: (image: PreviewableImage) => void;
  onSend: (text: string) => Promise<void>;
  onModelChange: (modelKey: string) => void;
  onThinkingLevelChange: (thinkingLevel: ButlerThinkingLevel) => void;
}) {
  const [draft, setDraft] = useState(() => readStoredValue(draftStorageKey));
  const [dragActive, setDragActive] = useState(false);
  const persistTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  async function handleSend() {
    const text = draft.trim();
    if (!text && images.length === 0) {
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

  const canSend = (draft.trim().length > 0 || images.length > 0) && uploadingImages === 0;

  return (
    <div
      className={`composer${dragActive ? " is-drop-target" : ""}`}
      onDragEnter={(event) => {
        if (isImageDrag(event)) {
          event.preventDefault();
          setDragActive(true);
        }
      }}
      onDragOver={(event) => {
        if (isImageDrag(event)) {
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
        if (!isImageDrag(event)) {
          return;
        }
        onFilesSelected(event.dataTransfer.files);
      }}
    >
      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={handleFileSelection} />
      {images.length > 0 || uploadingImages > 0 ? (
        <div>
          {images.length > 0 ? (
            <div className="composer-attachments composer-attachments-static">
              {images.map((image) => (
                <div key={image.id} className="composer-attachment">
                  <button
                    className="composer-attachment-preview"
                    type="button"
                    onClick={() => onPreviewImage({ id: image.id, name: image.name, url: image.url })}
                    aria-label={`Preview ${image.name}`}
                    title={image.name}
                  >
                    <img src={image.url} alt={image.name} className="composer-attachment-thumb" />
                  </button>
                  <div className="composer-attachment-copy">
                    <button
                      className="composer-attachment-name composer-attachment-name-button"
                      type="button"
                      onClick={() => onPreviewImage({ id: image.id, name: image.name, url: image.url })}
                      title={image.name}
                    >
                      {image.name}
                    </button>
                  </div>
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    onClick={() => onRemoveImage(image.id)}
                    aria-label={`Remove ${image.name}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {uploadingImages > 0 ? <div className="composer-uploading">Uploading {uploadingImages}…</div> : null}
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
            aria-label="Add image"
            title="Add image"
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
          <button className="composer-add-image" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Add image" title="Add image">
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
      {dragActive ? <div className="composer-drop-note">Drop image files to attach them</div> : null}
    </div>
  );
});
