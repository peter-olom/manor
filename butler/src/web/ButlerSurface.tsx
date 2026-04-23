import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { getJson, postJson, uploadAttachment } from "./api";
import { ButlerComposer } from "./ButlerComposer";
import { ArrowDownIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from "./icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { PreviewVerificationSummary } from "./PreviewVerificationSummary";
import { RuntimePanel } from "./RuntimePanel";
import { mergeKnownImages, useButlerLiveSnapshot, useKnownImages, useRuntimeSnapshot, useShellSnapshot } from "./live-state";
import type {
  ButlerHistoryPageResponse,
  ButlerHistoryState,
  FileReference,
  PreviewMedia
} from "./types";
import {
  BUTLER_DRAFT_STORAGE_KEY,
  BUTLER_HISTORY_AUTOLOAD_THRESHOLD_PX,
  BUTLER_HISTORY_PAGE_SIZE,
  BUTLER_RUNTIME_VISIBILITY_STORAGE_KEY,
  buildMessageImageLookup,
  dedupeMessages,
  formatAttachmentSummary,
  formatContextUsage,
  formatJumpLabel,
  formatVerificationSummary,
  groupTimelineItems,
  readStoredValue,
  scrollElementToCenteredTarget,
  scrollElementToLatest,
  writeStoredValue
} from "./utils";

type ButlerSurfaceProps = {
  onOpenThread: (threadId: string) => void;
  onPreviewMedia: (media: PreviewMedia) => void;
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void;
  showErrorToast: (error: unknown, key?: string, duration?: number) => void;
  copyText: (value: string, successMessage: string) => Promise<void>;
};

export function ButlerSurface({ onOpenThread, onPreviewMedia, showToast, showErrorToast, copyText }: ButlerSurfaceProps) {
  const shell = useShellSnapshot();
  const live = useButlerLiveSnapshot();
  const runtime = useRuntimeSnapshot();
  const knownImages = useKnownImages();
  const [history, setHistory] = useState<ButlerHistoryState>({ messages: [], loadedStart: 0, totalCount: 0 });
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [followButler, setFollowButler] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showRuntime, setShowRuntime] = useState(() => readStoredValue(BUTLER_RUNTIME_VISIBILITY_STORAGE_KEY) === "true");
  const [activeJumpId, setActiveJumpId] = useState<string | null>(null);
  const [pendingButlerText, setPendingButlerText] = useState<string | null>(null);
  const [butlerAttachments, setButlerAttachments] = useState<FileReference[]>([]);
  const [butlerUploadingAttachments, setButlerUploadingAttachments] = useState(0);
  const [busyStackId, setBusyStackId] = useState<string | null>(null);
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const butlerScrollRef = useRef<HTMLDivElement | null>(null);
  const butlerTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const butlerScrollTopRef = useRef(0);
  const butlerPrependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const butlerMessageTimesRef = useRef<Record<string, number>>({});
  const jumpFlashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(BUTLER_RUNTIME_VISIBILITY_STORAGE_KEY, showRuntime ? "true" : "false");
  }, [showRuntime]);

  useEffect(() => {
    if (!live) {
      return;
    }

    const tailMessages = live.messages;
    const tailStart = Math.max(0, live.messageCount - tailMessages.length);

    startTransition(() => {
      setHistory((current) => {
        if (live.messageCount === 0) {
          return { messages: [], loadedStart: 0, totalCount: 0 };
        }

        if (current.messages.length === 0 || current.loadedStart > tailStart || current.totalCount > live.messageCount) {
          return {
            messages: tailMessages,
            loadedStart: tailStart,
            totalCount: live.messageCount
          };
        }

        const prefixCount = Math.max(0, Math.min(current.messages.length, tailStart - current.loadedStart));
        const prefix = current.messages.slice(0, prefixCount);
        return {
          messages: dedupeMessages([
            ...prefix,
            ...tailMessages
          ]),
          loadedStart: prefix.length > 0 ? current.loadedStart : tailStart,
          totalCount: live.messageCount
        };
      });
    });
  }, [live]);

  useEffect(() => {
    const anchor = butlerPrependAnchorRef.current;
    if (!anchor) {
      return;
    }

    requestAnimationFrame(() => {
      const scroller = butlerScrollRef.current;
      if (!scroller) {
        return;
      }

      const delta = scroller.scrollHeight - anchor.scrollHeight;
      scroller.scrollTop = anchor.scrollTop + delta;
      butlerPrependAnchorRef.current = null;
    });
  }, [history.messages]);

  useEffect(() => {
    if (!pendingButlerText || !shell) {
      return;
    }

    const hasCommittedPrompt = history.messages.some((message) => message.role.startsWith("user") && message.text === pendingButlerText);
    if (hasCommittedPrompt || (!shell.butler.pending && !shell.butler.isStreaming)) {
      setPendingButlerText(null);
    }
  }, [history.messages, pendingButlerText, shell]);

  useEffect(() => {
    return () => {
      if (jumpFlashTimerRef.current !== null) {
        window.clearTimeout(jumpFlashTimerRef.current);
      }
    };
  }, []);

  async function uploadAttachments(files: FileList | File[]) {
    const uploadFiles = [...files];
    if (uploadFiles.length === 0) {
      return;
    }

    setButlerUploadingAttachments((current) => current + uploadFiles.length);

    try {
      const uploaded = await Promise.all(
        uploadFiles.map(async (file) => {
          const uploadedReference = await uploadAttachment(file);
          if (uploadedReference.mimeType.startsWith("image/")) {
            mergeKnownImages([uploadedReference]);
          }
          return uploadedReference;
        })
      );

      setButlerAttachments((current) => [...current, ...uploaded]);
      showToast(uploadFiles.length === 1 ? "File attached" : `${uploadFiles.length} files attached`);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setButlerUploadingAttachments((current) => Math.max(0, current - uploadFiles.length));
    }
  }

  async function loadOlderButlerMessages(): Promise<void> {
    if (loadingOlderMessages || history.loadedStart <= 0) {
      return;
    }

    const scroller = butlerScrollRef.current;
    if (scroller) {
      butlerPrependAnchorRef.current = {
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop
      };
    }

    setLoadingOlderMessages(true);
    try {
      const page = await getJson<ButlerHistoryPageResponse>(`/api/chat/history?before=${history.loadedStart}&limit=${BUTLER_HISTORY_PAGE_SIZE}`);
      startTransition(() => {
        setHistory((current) => ({
          messages: dedupeMessages([...page.messages, ...current.messages]),
          loadedStart: page.startIndex,
          totalCount: Math.max(current.totalCount, page.totalCount)
        }));
      });
    } catch (error) {
      showErrorToast(error);
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  async function sendButlerMessage(rawText: string) {
    const text = rawText.trim();
    const composerAttachments = [...butlerAttachments];
    if (!text && composerAttachments.length === 0) {
      return;
    }

    const attachmentCount = composerAttachments.length;
    const messageSummary = text || formatAttachmentSummary(attachmentCount);
    setButlerAttachments([]);
    setFollowButler(true);
    setPendingButlerText(messageSummary);

    try {
      const imageReferenceIds = composerAttachments.filter((item) => item.mimeType.startsWith("image/")).map((item) => item.id);
      const fileReferenceIds = composerAttachments.filter((item) => !item.mimeType.startsWith("image/")).map((item) => item.id);
      await postJson("/api/chat/messages", { text, imageReferenceIds, fileReferenceIds });
    } catch (error) {
      setPendingButlerText(null);
      setButlerAttachments((current) => (current.length === 0 ? composerAttachments : current));
      throw error;
    }
  }

  async function updateButlerCompose(modelKey: string, thinkingLevel: typeof shell.butler.compose.thinkingLevel = shell?.butler.compose.thinkingLevel ?? "medium") {
    if (!modelKey) {
      return;
    }

    try {
      await postJson("/api/chat/settings", { model: modelKey, thinkingLevel });
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

  function jumpToButlerPrompt(itemId: string) {
    const scroller = butlerScrollRef.current;
    const target = document.getElementById(`butler-message-${itemId}`);
    if (!scroller || !target) {
      return;
    }

    setFollowButler(false);
    requestAnimationFrame(() => {
      scrollElementToCenteredTarget(scroller, target);
      requestAnimationFrame(() => {
        triggerJumpFlash(itemId);
      });
    });
  }

  const butlerMessagesWithTimes = useMemo(
    () =>
      history.messages.map((message, index) => {
        const knownAt = message.at ?? butlerMessageTimesRef.current[message.id];
        if (typeof knownAt === "number" && Number.isFinite(knownAt)) {
          butlerMessageTimesRef.current[message.id] = knownAt;
          return { ...message, at: knownAt };
        }

        const fallbackAt = Date.now() - (history.messages.length - index) * 1000;
        butlerMessageTimesRef.current[message.id] = fallbackAt;
        return { ...message, at: fallbackAt };
      }),
    [history.messages]
  );
  const butlerPromptJumpList = useMemo(
    () => butlerMessagesWithTimes.filter((message) => message.role.startsWith("user")),
    [butlerMessagesWithTimes]
  );
  const butlerTimelineGroups = useMemo(() => groupTimelineItems(butlerPromptJumpList), [butlerPromptJumpList]);
  const butlerConversationRows = useMemo(
    () => [
      ...butlerMessagesWithTimes.map((message) => ({ id: message.id, kind: "message" as const, message })),
      ...(pendingButlerText ? [{ id: `pending-${pendingButlerText}`, kind: "pending" as const, text: pendingButlerText }] : []),
      ...((shell?.butler.pending || shell?.butler.isStreaming) ? [{ id: "butler-working", kind: "working" as const }] : [])
    ],
    [butlerMessagesWithTimes, pendingButlerText, shell?.butler.isStreaming, shell?.butler.pending]
  );
  const deferredRows = useDeferredValue(butlerConversationRows);
  const latestButlerActivityKey =
    deferredRows.length > 0 ? `${deferredRows[deferredRows.length - 1].id}:${deferredRows.length}` : "empty";

  useLayoutEffect(() => {
    if (!followButler || butlerPrependAnchorRef.current) {
      return;
    }

    scrollElementToLatest(butlerScrollRef.current);
  }, [followButler, latestButlerActivityKey, showRuntime]);

  useEffect(() => {
    if (!followButler || butlerPrependAnchorRef.current || typeof ResizeObserver === "undefined") {
      return;
    }

    const scroller = butlerScrollRef.current;
    if (!scroller) {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (butlerPrependAnchorRef.current) {
        return;
      }
      scrollElementToLatest(scroller);
    });

    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [followButler, latestButlerActivityKey, showRuntime, deferredRows.length]);

  const messageImages = useMemo(
    () =>
      buildMessageImageLookup(
        deferredRows
          .filter((row): row is Extract<(typeof deferredRows)[number], { kind: "message" }> => row.kind === "message")
          .map((row) => ({
            id: row.id,
            text: row.message.text || "",
            includeImages: !row.message.role.startsWith("assistant")
          })),
        knownImages
      ),
    [deferredRows, knownImages]
  );

  const activeRuntimeLeaseCount = (runtime?.stacks.filter((stack) => stack.status !== "stopped").length ?? 0) +
    (runtime?.previews.filter((lease) => lease.status !== "stopped").length ?? 0) +
    (runtime?.services.filter((service) => service.status !== "stopped").length ?? 0);
  const butlerStatus = (() => {
    if (!shell) {
      return "Loading";
    }
    if (!live) {
      return "Loading";
    }
    if (shell.butler.lastError) {
      return shell.butler.lastError;
    }
    if (shell.butler.compaction.active || shell.butler.isStreaming) {
      return "Working";
    }
    if (shell.butler.pending) {
      return "Running";
    }
    return "Ready";
  })();

  if (!shell) {
    return <div className="workspace-panel"><div className="shell loading">Loading Butler…</div></div>;
  }

  const butlerModelKey = shell.butler.compose.model ?? "";

  return (
    <div className="workspace-panel">
      <div className={`workspace-body ${showTimeline ? "is-detail-open" : "is-detail-closed"}`}>
        <section className="conversation-pane conversation-pane-full has-toolbar">
          <div className="conversation-toolbar">
            <div className="conversation-toolbar-group">
              {runtime && activeRuntimeLeaseCount > 0 ? (
                <div className="conversation-disclosure">
                  <button className={`conversation-toggle${showRuntime ? " is-active" : ""}`} onClick={() => setShowRuntime((current) => !current)} type="button">
                    <span className="conversation-toggle-icon" aria-hidden="true">
                      {showRuntime ? <ChevronUpIcon /> : <ChevronDownIcon />}
                    </span>
                    <span className="conversation-toggle-label">{showRuntime ? "Hide runtime" : "Show runtime"}</span>
                    <span className="conversation-toggle-count">{activeRuntimeLeaseCount}</span>
                  </button>
                  {showRuntime ? (
                    <div className="conversation-disclosure-panel runtime-disclosure-panel">
                      <RuntimePanel
                        stacks={runtime.stacks.filter((stack) => stack.status !== "stopped")}
                        previews={runtime.previews.filter((preview) => preview.status !== "stopped")}
                        services={runtime.services.filter((service) => service.status !== "stopped")}
                        busyStackId={busyStackId}
                        busyServiceId={busyServiceId}
                        onFocusThread={(threadId) => {
                          if (threadId) {
                            onOpenThread(threadId);
                          }
                        }}
                        onPinStack={(stackId, pinned) => void pinStackLease(stackId, pinned)}
                        onStopStack={(stackId) => void stopStackLease(stackId)}
                        onPinPreview={(leaseId, pinned) => void pinPreviewLease(leaseId, pinned)}
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
            </div>
          </div>
          <div
            ref={butlerScrollRef}
            className="conversation-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
              const isNearBottom = remaining < 32;
              butlerScrollTopRef.current = element.scrollTop;
              setFollowButler((current) => (current === isNearBottom ? current : isNearBottom));

              if (
                !isNearBottom &&
                element.scrollTop < BUTLER_HISTORY_AUTOLOAD_THRESHOLD_PX &&
                history.loadedStart > 0 &&
                !loadingOlderMessages &&
                butlerPrependAnchorRef.current === null
              ) {
                void loadOlderButlerMessages();
              }
            }}
          >
            {deferredRows.length === 0 ? (
              live ? (
                <div className="empty">Ask Butler about run status, next steps, or which run you should open.</div>
              ) : (
                <div className="conversation-list conversation-list-loading">
                  <div className="conversation-row is-assistant">
                    <div className="working-indicator is-pending" aria-live="polite">
                      <span className="working-indicator-label">Butler</span>
                      <span className="working-indicator-text">Loading conversation</span>
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="conversation-list">
                {deferredRows.map((row) => {
                  if (row.kind === "working") {
                    return (
                      <div key={row.id} className="conversation-row is-assistant">
                        <div className={`working-indicator ${shell.butler.isStreaming ? "is-streaming" : "is-pending"}`} aria-live="polite">
                          <span className="working-indicator-label">Butler</span>
                          <span className="working-indicator-text">{butlerStatus}</span>
                        </div>
                      </div>
                    );
                  }

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
                            <MarkdownMessage
                              text={row.text}
                              onPreviewMedia={onPreviewMedia}
                              onResourceUnavailable={(message) => showToast(message, "error", 5000)}
                            />
                          </div>
                        </article>
                      </div>
                    );
                  }

                  const message = row.message;
                  const toneClass = `is-${message.role.startsWith("assistant") ? "assistant" : "user"}`;
                  const rowToneClass = message.role.startsWith("assistant") ? "is-assistant" : "is-user";
                  const imageState = messageImages[row.id] ?? { displayText: message.text || "…", images: [], files: [] };

                  return (
                    <div key={row.id} className={`conversation-row ${rowToneClass}`}>
                      <article id={`butler-message-${message.id}`} className={`entry ${toneClass}${activeJumpId === message.id ? " is-jump-target" : ""}`}>
                        <div className="entry-head">
                          <span>{message.role.startsWith("assistant") ? "Butler" : "You"}</span>
                          <span className="entry-head-meta">
                            <span>{formatJumpLabel(message.at)}</span>
                            <button className="entry-copy" onClick={() => void copyText(message.text || "", "Message copied")} aria-label="Copy message" title="Copy message">
                              <CopyIcon />
                            </button>
                          </span>
                        </div>
                        <div className="entry-text">
                          <MarkdownMessage
                            text={imageState.displayText}
                            onPreviewMedia={onPreviewMedia}
                            onResourceUnavailable={(message) => showToast(message, "error", 5000)}
                          />
                          {imageState.images.length > 0 ? (
                            <div className="message-image-strip">
                              {imageState.images.map((image) => (
                                <button key={image.id} className="message-image-button" type="button" onClick={() => onPreviewMedia({ name: image.name, url: image.url, kind: "image", downloadUrl: image.url })}>
                                  <img src={image.url} alt={image.name} className="message-image-thumb" />
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {imageState.files.length > 0 ? (
                            <div className="message-file-strip">
                              {imageState.files.map((file) => (
                                <a
                                  key={file.id}
                                  className="message-file-pill"
                                  href={file.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={file.name}
                                >
                                  {file.name}
                                </a>
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
          {!followButler ? (
            <button className="conversation-jump-latest" onClick={() => {
              setFollowButler(true);
              requestAnimationFrame(() => {
                scrollElementToLatest(butlerScrollRef.current);
              });
            }} type="button" aria-label="Jump to latest Butler message">
              <span className="conversation-jump-latest-icon" aria-hidden="true">
                <ArrowDownIcon />
              </span>
              <span>Latest</span>
            </button>
          ) : null}
          <ButlerComposer
            draftStorageKey={BUTLER_DRAFT_STORAGE_KEY}
            modelKey={butlerModelKey}
            thinkingLevel={shell.butler.compose.thinkingLevel}
            availableModels={shell.butler.compose.availableModels}
            availableThinkingLevels={shell.butler.compose.availableThinkingLevels}
            attachments={butlerAttachments}
            uploadingAttachments={butlerUploadingAttachments}
            onFilesSelected={(files) => void uploadAttachments(files)}
            onRemoveAttachment={(attachmentId) => setButlerAttachments((current) => current.filter((entry) => entry.id !== attachmentId))}
            onPreviewImage={(image) => onPreviewMedia({ name: image.name, url: image.url, kind: "image", downloadUrl: image.url })}
            onSend={async (text) => {
              try {
                await sendButlerMessage(text);
              } catch (error) {
                showErrorToast(error);
                throw error;
              }
            }}
            onModelChange={(model) => void updateButlerCompose(model)}
            onThinkingLevelChange={(level) => void updateButlerCompose(butlerModelKey, level)}
          />
        </section>
        <aside className={`detail-pane ${showTimeline ? "is-open" : "is-closed"}`}>
          {showTimeline ? (
            <section className="detail-block">
              <div className="detail-header">
                <span className="eyebrow">Timeline</span>
                <div className="detail-actions">
                  {butlerTimelineGroups.length > 1 ? (
                    <select className="detail-select" aria-label="Jump to date" defaultValue="" onChange={(event) => {
                      const itemId = event.target.value;
                      if (!itemId) {
                        return;
                      }
                      jumpToButlerPrompt(itemId);
                      event.target.value = "";
                    }}>
                      <option value="">Jump to date</option>
                      {butlerTimelineGroups.map((group) => (
                        <option key={group.key} value={group.firstId}>
                          {group.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button className="detail-dismiss" onClick={() => setShowTimeline(false)} aria-label="Hide timeline">×</button>
                </div>
              </div>
              <div ref={butlerTimelineScrollRef} className="detail-list-scroll">
                {butlerTimelineGroups.length === 0 ? (
                  <div className="empty">No prompts yet.</div>
                ) : (
                  butlerTimelineGroups.map((group) => (
                    <section key={group.key} className="detail-group">
                      <div className="detail-group-label">{group.label}</div>
                      <div className="detail-group-items">
                        {group.items.map((message, index) => (
                          <button key={message.id} className="detail-link" onClick={() => jumpToButlerPrompt(message.id)}>
                            {index + 1}. {formatJumpLabel(message.at)} • {message.text}
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
