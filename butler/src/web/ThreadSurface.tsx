import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import { postJson, readFileAsBase64 } from "./api";
import { ArrowDownIcon, AttachmentIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, SendIcon, TrashIcon } from "./icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { PreviewVerificationSummary } from "./PreviewVerificationSummary";
import { RuntimePanel } from "./RuntimePanel";
import { mergeKnownImages, useKnownImages, useRuntimeSnapshot, useShellSnapshot, useThreadDetail } from "./live-state";
import type {
  ImageReference,
  PreviewMedia,
  ReasoningEffort
} from "./types";
import {
  THREAD_DRAFT_STORAGE_KEY_PREFIX,
  buildMessageImageLookup,
  formatAttachmentSummary,
  formatContextUsage,
  formatJumpLabel,
  formatThreadBudget,
  groupTimelineItems,
  isImageDrag,
  itemLabel,
  itemTone,
  readStoredValue,
  resizeComposerTextarea,
  scrollElementToCenteredTarget,
  scrollElementToLatest,
  shouldRenderItem,
  writeStoredValue
} from "./utils";

type ThreadSurfaceProps = {
  threadId: string | null;
  onPreviewMedia: (media: PreviewMedia) => void;
  onOpenThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void;
  showErrorToast: (error: unknown, key?: string, duration?: number) => void;
  copyText: (value: string, successMessage: string) => Promise<void>;
};

export function ThreadSurface({
  threadId,
  onPreviewMedia,
  onOpenThread,
  onDeleteThread,
  showToast,
  showErrorToast,
  copyText
}: ThreadSurfaceProps) {
  const shell = useShellSnapshot();
  const runtime = useRuntimeSnapshot();
  const knownImages = useKnownImages();
  const activeThread = useThreadDetail(threadId);
  const [threadDraft, setThreadDraft] = useState("");
  const [threadImages, setThreadImages] = useState<ImageReference[]>([]);
  const [threadUploadingImages, setThreadUploadingImages] = useState(0);
  const [threadDragActive, setThreadDragActive] = useState(false);
  const [pendingThreadRequest, setPendingThreadRequest] = useState<{
    threadId: string;
    text: string;
    sentAt: number;
  } | null>(null);
  const [followRun, setFollowRun] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showThreadRuntime, setShowThreadRuntime] = useState(false);
  const [busyStackId, setBusyStackId] = useState<string | null>(null);
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const [busyPreviewVerification, setBusyPreviewVerification] = useState<{ leaseId: string; mode: "headless" | "headful" } | null>(null);
  const [activeJumpId, setActiveJumpId] = useState<string | null>(null);
  const runScrollRef = useRef<HTMLDivElement | null>(null);
  const runTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const runScrollTopRef = useRef(0);
  const threadTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadFileInputRef = useRef<HTMLInputElement | null>(null);
  const threadDraftPersistTimerRef = useRef<number | null>(null);
  const jumpFlashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const nextThreadId = activeThread?.id ?? null;
    setThreadDraft(nextThreadId ? readStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${nextThreadId}`) : "");
    setThreadImages([]);
    setFollowRun(true);
    setShowThreadRuntime(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id) {
      return;
    }

    if (threadDraftPersistTimerRef.current !== null) {
      window.clearTimeout(threadDraftPersistTimerRef.current);
    }

    threadDraftPersistTimerRef.current = window.setTimeout(() => {
      writeStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${activeThread.id}`, threadDraft);
      threadDraftPersistTimerRef.current = null;
    }, 180);

    return () => {
      if (threadDraftPersistTimerRef.current !== null) {
        window.clearTimeout(threadDraftPersistTimerRef.current);
        threadDraftPersistTimerRef.current = null;
      }
    };
  }, [activeThread?.id, threadDraft]);

  useEffect(() => {
    resizeComposerTextarea(threadTextareaRef.current);
  }, [threadDraft]);

  useEffect(() => {
    return () => {
      if (jumpFlashTimerRef.current !== null) {
        window.clearTimeout(jumpFlashTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!pendingThreadRequest || !activeThread) {
      return;
    }

    const threadItems = activeThread.turns.flatMap((turn) => turn.items.filter(shouldRenderItem));
    const hasResponseAfterSend = threadItems.some((item) => item.type !== "userMessage" && item.at >= pendingThreadRequest.sentAt);

    if (hasResponseAfterSend && activeThread.status !== "active") {
      setPendingThreadRequest((current) =>
        current?.threadId === pendingThreadRequest.threadId && current.sentAt === pendingThreadRequest.sentAt ? null : current
      );
    }
  }, [activeThread, pendingThreadRequest]);

  async function uploadThreadImages(files: FileList | File[]) {
    const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      showToast("Only image files are supported", "error");
      return;
    }

    setThreadUploadingImages((current) => current + imageFiles.length);
    try {
      const uploaded = await Promise.all(
        imageFiles.map(async (file) => {
          const data = await readFileAsBase64(file);
          const result = await postJson<{ ok: true; image: ImageReference }>("/api/images/upload", {
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            data
          });
          return result.image;
        })
      );
      setThreadImages((current) => [...current, ...uploaded]);
      mergeKnownImages(uploaded);
      showToast(imageFiles.length === 1 ? "Image attached" : `${imageFiles.length} images attached`);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setThreadUploadingImages((current) => Math.max(0, current - imageFiles.length));
    }
  }

  async function sendThreadMessage() {
    if (!activeThread) {
      return;
    }

    const text = threadDraft.trim();
    const composerImages = [...threadImages];
    if (!text && composerImages.length === 0) {
      return;
    }

    const messageSummary = text || formatAttachmentSummary(composerImages.length);
    setThreadDraft("");
    setThreadImages([]);
    writeStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${activeThread.id}`, "");
    setFollowRun(true);
    setPendingThreadRequest({
      threadId: activeThread.id,
      text: messageSummary,
      sentAt: Date.now()
    });

    try {
      await postJson("/api/threads/messages", {
        threadId: activeThread.id,
        text,
        imageReferenceIds: composerImages.map((image) => image.id)
      });
    } catch (error) {
      setPendingThreadRequest((current) => (current?.threadId === activeThread.id && current.text === messageSummary ? null : current));
      setThreadDraft((current) => (current.trim().length === 0 ? text : current));
      setThreadImages((current) => (current.length === 0 ? composerImages : current));
      showErrorToast(error);
    }
  }

  async function updateCodexCompose(model: string, effort: ReasoningEffort | null) {
    try {
      await postJson("/api/threads/settings", { model, effort });
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function updateThreadSupervision(nextThreadId: string, maxButlerTurns: number | null) {
    try {
      await postJson("/api/threads/supervision", { threadId: nextThreadId, maxButlerTurns });
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function stopStackLease(stackId: string) {
    setBusyStackId(stackId);
    try {
      await postJson("/api/stacks/stop", { stackId });
      showToast("Stack stopped");
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyStackId((current) => (current === stackId ? null : current));
    }
  }

  async function pinStackLease(stackId: string, pinned: boolean) {
    try {
      await postJson("/api/stacks/pin", { stackId, pinned });
      showToast(pinned ? "Stack pinned" : "Stack unpinned");
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function stopPreviewLease(leaseId: string) {
    try {
      await postJson("/api/previews/stop", { leaseId });
      showToast("Preview stopped");
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function verifyPreviewLease(leaseId: string, mode: "headless" | "headful" = "headless") {
    setBusyPreviewVerification({ leaseId, mode });
    try {
      const result = await postJson<{ ok: true; verification: { ok: boolean; title: string; status: number | null } }>("/api/previews/verify", { leaseId, mode });
      showToast(
        result.verification.ok
          ? `Preview verified${result.verification.title ? `: ${result.verification.title}` : ""}`
          : `Preview check failed${result.verification.status ? ` (${result.verification.status})` : ""}`
      );
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyPreviewVerification((current) => (current?.leaseId === leaseId && current.mode === mode ? null : current));
    }
  }

  async function stopServiceLease(serviceId: string) {
    setBusyServiceId(serviceId);
    try {
      await postJson("/api/services/stop", { serviceId });
      showToast("Service stopped");
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyServiceId((current) => (current === serviceId ? null : current));
    }
  }

  async function pinPreviewLease(leaseId: string, pinned: boolean) {
    try {
      await postJson("/api/previews/pin", { leaseId, pinned });
      showToast(pinned ? "Preview pinned" : "Preview unpinned");
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function pinServiceLease(serviceId: string, pinned: boolean) {
    try {
      await postJson("/api/services/pin", { serviceId, pinned });
      showToast(pinned ? "Service pinned" : "Service unpinned");
    } catch (error) {
      showErrorToast(error);
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    submit();
  }

  function triggerJumpFlash(itemId: string) {
    setActiveJumpId(null);
    requestAnimationFrame(() => {
      setActiveJumpId(itemId);
      if (jumpFlashTimerRef.current !== null) {
        window.clearTimeout(jumpFlashTimerRef.current);
      }
      jumpFlashTimerRef.current = window.setTimeout(() => {
        setActiveJumpId((current) => (current === itemId ? null : current));
        jumpFlashTimerRef.current = null;
      }, 1400);
    });
  }

  function jumpToRunPrompt(itemId: string) {
    const scroller = runScrollRef.current;
    const target = document.getElementById(`run-message-${itemId}`);
    if (!scroller || !target) {
      return;
    }

    setFollowRun(false);
    requestAnimationFrame(() => {
      scrollElementToCenteredTarget(scroller, target);
      requestAnimationFrame(() => {
        triggerJumpFlash(itemId);
      });
    });
  }

  const activeRunItems = useMemo(
    () =>
      activeThread
        ? activeThread.turns.flatMap((turn) => turn.items.filter(shouldRenderItem).map((item) => ({ ...item, turnId: turn.id, turnStartedAt: turn.startedAt })))
        : [],
    [activeThread]
  );
  const showPendingThreadEntry = Boolean(
    pendingThreadRequest &&
      activeThread &&
      pendingThreadRequest.threadId === activeThread.id &&
      !activeRunItems.some((item) => item.type === "userMessage" && item.at >= pendingThreadRequest.sentAt - 1000)
  );
  const showThreadWorkingIndicator = Boolean(pendingThreadRequest && activeThread && pendingThreadRequest.threadId === activeThread.id) || activeThread?.status === "active";
  const runPromptJumpList = useMemo(() => activeRunItems.filter((item) => item.type === "userMessage"), [activeRunItems]);
  const runTimelineGroups = useMemo(() => groupTimelineItems(runPromptJumpList), [runPromptJumpList]);
  const runConversationRows = useMemo(
    () => [
      ...activeRunItems.map((item) => ({ id: item.id, kind: "item" as const, item })),
      ...(showPendingThreadEntry && pendingThreadRequest ? [{ id: `pending-${pendingThreadRequest.sentAt}`, kind: "pending" as const, text: pendingThreadRequest.text }] : []),
      ...(showThreadWorkingIndicator ? [{ id: `working-${activeThread?.id ?? "thread"}`, kind: "working" as const }] : [])
    ],
    [activeRunItems, activeThread?.id, pendingThreadRequest, showPendingThreadEntry, showThreadWorkingIndicator]
  );
  const deferredRows = useDeferredValue(runConversationRows);
  const latestRunActivityKey = deferredRows.length > 0 ? `${deferredRows[deferredRows.length - 1].id}:${deferredRows.length}` : "empty";

  useEffect(() => {
    if (!followRun || !runScrollRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollElementToLatest(runScrollRef.current);
    });
  }, [followRun, latestRunActivityKey]);

  const messageImages = useMemo(
    () =>
      buildMessageImageLookup(
        deferredRows
          .filter((row): row is Extract<(typeof deferredRows)[number], { kind: "item" }> => row.kind === "item")
          .map((row) => ({
            id: row.id,
            text: row.item.text || "",
            includeImages: row.item.type === "userMessage"
          })),
        knownImages
      ),
    [deferredRows, knownImages]
  );

  const activeThreadStacks =
    activeThread && runtime ? runtime.stacks.filter((stack) => stack.threadId === activeThread.id && stack.status !== "stopped") : [];
  const activeThreadPreviews =
    activeThread && runtime ? runtime.previews.filter((lease) => lease.threadId === activeThread.id && lease.status !== "stopped") : [];
  const activeThreadServices =
    activeThread && runtime ? runtime.services.filter((service) => service.threadId === activeThread.id && service.status !== "stopped") : [];
  const activeThreadPreviewVerification =
    activeThreadPreviews.find((lease) => Boolean(lease.lastVerification))?.lastVerification ??
    (activeThread && runtime ? runtime.latestPreviewProofsByThreadId[activeThread.id]?.verification ?? null : null);
  const activeThreadRuntimeLeaseCount = activeThreadStacks.length + activeThreadPreviews.length + activeThreadServices.length;

  if (!shell || !runtime || !activeThread) {
    return <div className="workspace-panel"><div className="empty">This run is open, but its turn history has not loaded yet.</div></div>;
  }

  const codexEffortOptions =
    shell.codex.compose.availableModels.find((model) => model.id === shell.codex.compose.model)?.supportedReasoningEfforts ?? [];

  return (
    <div className="workspace-panel">
      <div className="thread-toolbar">
        <div className="thread-toolbar-group">
          {activeThreadRuntimeLeaseCount > 0 ? (
            <div className="conversation-disclosure thread-toolbar-disclosure">
              <button className={`conversation-toggle thread-toolbar-toggle${showThreadRuntime ? " is-active" : ""}`} onClick={() => setShowThreadRuntime((current) => !current)} type="button">
                <span className="conversation-toggle-icon" aria-hidden="true">
                  {showThreadRuntime ? <ChevronUpIcon /> : <ChevronDownIcon />}
                </span>
                <span className="conversation-toggle-label">{showThreadRuntime ? "Hide runtime" : "Show runtime"}</span>
                <span className="conversation-toggle-count">{activeThreadRuntimeLeaseCount}</span>
              </button>
              {showThreadRuntime ? (
                <div className="conversation-disclosure-panel runtime-disclosure-panel thread-runtime-panel">
                  <RuntimePanel
                    stacks={activeThreadStacks}
                    previews={activeThreadPreviews}
                    services={activeThreadServices}
                    busyStackId={busyStackId}
                    busyPreviewVerification={busyPreviewVerification}
                    busyServiceId={busyServiceId}
                    onFocusThread={(nextThreadId) => {
                      if (nextThreadId) {
                        onOpenThread(nextThreadId);
                      }
                    }}
                    onPinStack={(stackId, pinned) => void pinStackLease(stackId, pinned)}
                    onStopStack={(stackId) => void stopStackLease(stackId)}
                    onPinPreview={(leaseId, pinned) => void pinPreviewLease(leaseId, pinned)}
                    onVerifyPreview={(leaseId, mode) => void verifyPreviewLease(leaseId, mode)}
                    onStopPreview={(leaseId) => void stopPreviewLease(leaseId)}
                    onPinService={(serviceId, pinned) => void pinServiceLease(serviceId, pinned)}
                    onStopService={(serviceId) => void stopServiceLease(serviceId)}
                    onPreviewArtifact={onPreviewMedia}
                    onResourceUnavailable={(message) => showToast(message, "error", 5000)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onDeleteThread(activeThread.id)} aria-label="Delete thread" title="Delete thread">
            <TrashIcon />
          </button>
        </div>
      </div>
      {activeThreadPreviewVerification ? (
        <div className="thread-preview-verification">
          <PreviewVerificationSummary verification={activeThreadPreviewVerification} onPreviewArtifact={onPreviewMedia} onResourceUnavailable={(message) => showToast(message, "error", 5000)} />
        </div>
      ) : null}

      <div className={`workspace-body ${showTimeline ? "is-detail-open" : "is-detail-closed"}`}>
        <section className="conversation-pane conversation-pane-full">
          <div
            ref={runScrollRef}
            className="conversation-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
              const isNearBottom = remaining < 32;
              runScrollTopRef.current = element.scrollTop;
              setFollowRun((current) => (current === isNearBottom ? current : isNearBottom));
            }}
          >
            {deferredRows.length === 0 ? (
              <div className="empty">This run is open, but its turn history has not loaded yet.</div>
            ) : (
              <div className="conversation-list">
                {deferredRows.map((row) => {
                  if (row.kind === "pending") {
                    return (
                      <div key={row.id} className="conversation-row is-user">
                        <article className="entry is-user is-pending">
                          <div className="entry-head">
                            <span>You</span>
                            <span className="entry-head-meta">
                              <span>sending</span>
                              <button className="entry-copy" onClick={() => void copyText(row.text, "Message copied")} aria-label="Copy message" title="Copy message">
                                <CopyIcon />
                              </button>
                            </span>
                          </div>
                          <div className="entry-text">
                            <MarkdownMessage text={row.text} onPreviewMedia={onPreviewMedia} onResourceUnavailable={(message) => showToast(message, "error", 5000)} />
                          </div>
                        </article>
                      </div>
                    );
                  }

                  if (row.kind === "working") {
                    return (
                      <div key={row.id} className="conversation-row is-assistant">
                        <div className={`working-indicator ${activeThread.status === "active" ? "is-streaming" : "is-pending"}`} aria-live="polite">
                          <span className="working-indicator-label">Codex</span>
                          <span className="working-indicator-text">{activeThread.status === "active" ? "Working" : "Running"}</span>
                        </div>
                      </div>
                    );
                  }

                  const tone = itemTone(row.item.type);
                  const rowToneClass = tone === "user" ? "is-user" : "is-assistant";
                  const imageState = messageImages[row.id] ?? { displayText: row.item.text || "Running shell command", images: [] };

                  return (
                    <div key={row.id} className={`conversation-row ${rowToneClass}`}>
                      <article id={`run-message-${row.item.id}`} className={`entry is-${tone}${activeJumpId === row.item.id ? " is-jump-target" : ""}`}>
                        <div className="entry-head">
                          <span>{itemLabel(row.item.type)}</span>
                          <span className="entry-head-meta">
                            <span>{formatJumpLabel(row.item.at)}</span>
                            <button className="entry-copy" onClick={() => void copyText(row.item.text || "", "Message copied")} aria-label="Copy message" title="Copy message">
                              <CopyIcon />
                            </button>
                          </span>
                        </div>
                        <div className="entry-text">
                          <MarkdownMessage text={imageState.displayText || "Running shell command"} onPreviewMedia={onPreviewMedia} onResourceUnavailable={(message) => showToast(message, "error", 5000)} />
                          {imageState.images.length > 0 ? (
                            <div className="message-image-strip">
                              {imageState.images.map((image) => (
                                <button key={image.id} className="message-image-button" type="button" onClick={() => onPreviewMedia({ name: image.name, url: image.url, kind: "image", downloadUrl: image.url })}>
                                  <img src={image.url} alt={image.name} className="message-image-thumb" />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {!followRun ? (
            <button className="conversation-jump-latest" onClick={() => {
              setFollowRun(true);
              requestAnimationFrame(() => {
                scrollElementToLatest(runScrollRef.current);
              });
            }} type="button" aria-label="Jump to latest Codex message">
              <span className="conversation-jump-latest-icon" aria-hidden="true">
                <ArrowDownIcon />
              </span>
              <span>Latest</span>
            </button>
          ) : null}
          <div
            className={`composer${threadDragActive ? " is-drop-target" : ""}`}
            onDragEnter={(event) => {
              if (isImageDrag(event)) {
                event.preventDefault();
                setThreadDragActive(true);
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
              setThreadDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setThreadDragActive(false);
              if (!isImageDrag(event)) {
                return;
              }
              void uploadThreadImages(event.dataTransfer.files);
            }}
          >
            <input ref={threadFileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) {
                void uploadThreadImages(files);
              }
              event.target.value = "";
            }} />
            {threadImages.length > 0 || threadUploadingImages > 0 ? (
              <div>
                {threadImages.length > 0 ? (
                  <div className="composer-attachments composer-attachments-static">
                    {threadImages.map((image) => (
                      <div key={image.id} className="composer-attachment">
                        <button className="composer-attachment-preview" type="button" onClick={() => onPreviewMedia({ name: image.name, url: image.url, kind: "image", downloadUrl: image.url })}>
                          <img src={image.url} alt={image.name} className="composer-attachment-thumb" />
                        </button>
                        <div className="composer-attachment-copy">
                          <button className="composer-attachment-name composer-attachment-name-button" type="button" onClick={() => onPreviewMedia({ name: image.name, url: image.url, kind: "image", downloadUrl: image.url })}>
                            {image.name}
                          </button>
                        </div>
                        <button className="composer-attachment-remove" type="button" onClick={() => setThreadImages((current) => current.filter((entry) => entry.id !== image.id))}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {threadUploadingImages > 0 ? <div className="composer-uploading">Uploading {threadUploadingImages}…</div> : null}
              </div>
            ) : null}
            <div className="composer-main">
              <textarea
                ref={threadTextareaRef}
                name="codex-thread-message"
                value={threadDraft}
                onChange={(event) => setThreadDraft(event.target.value)}
                onKeyDown={(event) => handleComposerKeyDown(event, () => void sendThreadMessage())}
                placeholder="Send a message directly into this run"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={true}
                rows={3}
              />
              <div className="composer-mobile-actions">
                <button className="composer-add-image composer-add-image-mobile" type="button" onClick={() => threadFileInputRef.current?.click()} aria-label="Add image" title="Add image">
                  <AttachmentIcon />
                </button>
                <button className="composer-send composer-send-mobile" onClick={() => void sendThreadMessage()} disabled={(!threadDraft.trim() && threadImages.length === 0) || threadUploadingImages > 0} aria-label="Send message">
                  <span className="composer-send-label">Send</span>
                  <span className="composer-send-icon">
                    <SendIcon />
                  </span>
                </button>
              </div>
            </div>
            <div className="composer-footer">
              <div className="composer-inline-controls">
                <select
                  value={shell.codex.compose.model ?? ""}
                  onChange={(event) => {
                    const nextModel = event.target.value;
                    const model = shell.codex.compose.availableModels.find((entry) => entry.id === nextModel);
                    void updateCodexCompose(nextModel, model?.defaultReasoningEffort ?? null);
                  }}
                  aria-label="Codex model"
                >
                  {shell.codex.compose.availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <select
                  value={shell.codex.compose.effort ?? ""}
                  onChange={(event) => void updateCodexCompose(shell.codex.compose.model ?? "", (event.target.value || null) as ReasoningEffort | null)}
                  disabled={!shell.codex.compose.model || codexEffortOptions.length === 0}
                  aria-label="Codex reasoning"
                >
                  {codexEffortOptions.length === 0 ? (
                    <option value="">Standard</option>
                  ) : (
                    codexEffortOptions.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))
                  )}
                </select>
                <div className={`composer-thread-budget${activeThread.supervision.capReached ? " is-capped" : ""}`}>
                  <span className="composer-thread-budget-value">{formatThreadBudget(activeThread.supervision)}</span>
                  <select
                    value={activeThread.supervision.maxButlerTurns === null ? "null" : String(activeThread.supervision.maxButlerTurns)}
                    onChange={(event) => void updateThreadSupervision(activeThread.id, event.target.value === "null" ? null : Number(event.target.value))}
                    aria-label="Butler thread turn limit"
                  >
                    <option value="20">20 turns</option>
                    <option value="40">40 turns</option>
                    <option value="100">100 turns</option>
                    <option value="null">No limit</option>
                  </select>
                </div>
              </div>
              <div className="composer-note">Cmd/Ctrl + Enter sends</div>
              <div className="composer-actions composer-actions-desktop">
                <button className="composer-add-image" type="button" onClick={() => threadFileInputRef.current?.click()} aria-label="Add image" title="Add image">
                  <AttachmentIcon />
                </button>
                <button className="composer-send composer-send-desktop" onClick={() => void sendThreadMessage()} disabled={(!threadDraft.trim() && threadImages.length === 0) || threadUploadingImages > 0} aria-label="Send message">
                  <span className="composer-send-label">Send</span>
                  <span className="composer-send-icon">
                    <SendIcon />
                  </span>
                </button>
              </div>
            </div>
            {threadDragActive ? <div className="composer-drop-note">Drop image files to attach them</div> : null}
          </div>
        </section>
        <aside className={`detail-pane ${showTimeline ? "is-open" : "is-closed"}`}>
          {showTimeline ? (
            <section className="detail-block">
              <div className="detail-header">
                <span className="eyebrow">Timeline</span>
                <div className="detail-actions">
                  {runTimelineGroups.length > 1 ? (
                    <select className="detail-select" aria-label="Jump to date" defaultValue="" onChange={(event) => {
                      const itemId = event.target.value;
                      if (!itemId) {
                        return;
                      }
                      jumpToRunPrompt(itemId);
                      event.target.value = "";
                    }}>
                      <option value="">Jump to date</option>
                      {runTimelineGroups.map((group) => (
                        <option key={group.key} value={group.firstId}>
                          {group.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button className="detail-dismiss" onClick={() => setShowTimeline(false)} aria-label="Hide timeline">×</button>
                </div>
              </div>
              <div ref={runTimelineScrollRef} className="detail-list-scroll">
                {runTimelineGroups.length === 0 ? (
                  <div className="empty">No prompts yet.</div>
                ) : (
                  runTimelineGroups.map((group) => (
                    <section key={group.key} className="detail-group">
                      <div className="detail-group-label">{group.label}</div>
                      <div className="detail-group-items">
                        {group.items.map((item, index) => (
                          <button key={item.id} className="detail-link" onClick={() => jumpToRunPrompt(item.id)}>
                            {index + 1}. {formatJumpLabel(item.at)} • {item.text}
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </section>
          ) : (
            <button className="detail-open" onClick={() => setShowTimeline(true)} aria-label="Show timeline">Timeline</button>
          )}
        </aside>
      </div>
    </div>
  );
}
