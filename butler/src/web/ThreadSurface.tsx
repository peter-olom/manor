import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import { postJson, uploadAttachment } from "./api";
import { ArrowDownIcon, AttachmentIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, SendIcon, TrashIcon } from "./icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { PreviewVerificationSummary } from "./PreviewVerificationSummary";
import { RuntimePanel } from "./RuntimePanel";
import { mergeKnownImages, useKnownImages, useRuntimeSnapshot, useShellSnapshot, useThreadDetail } from "./live-state";
import type {
  ComposerPrefill,
  FileReference,
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
  isFileDrag,
  itemLabel,
  itemTone,
  readStoredValue,
  resizeComposerTextarea,
  scrollElementToCenteredTarget,
  scrollElementToLatest,
  shouldRenderItem,
  writeStoredValue
} from "./utils";

const FILE_UPLOAD_ACCEPT = ".pdf,.ppt,.pptx,.xls,.xlsx,.doc,.docx,.txt,.csv,.json,.md,.zip,image/*,*/*";

type ThreadScrollPosition = {
  top: number;
  follow: boolean;
};

type ThreadPanelState = {
  showTimeline: boolean;
  showThreadRuntime: boolean;
  showThreadProofs: boolean;
  expandedSystemItems: Record<string, boolean>;
  expandedToolGroups: Record<string, boolean>;
};

const threadScrollPositions = new Map<string, ThreadScrollPosition>();
const threadPanelStates = new Map<string, ThreadPanelState>();

type ThreadSurfaceProps = {
  threadId: string | null;
  onPreviewMedia: (media: PreviewMedia) => void;
  onOpenThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onDeleteProof: (proofId: string) => void;
  composerPrefill: ComposerPrefill | null;
  onComposerPrefillConsumed: (prefillId: string) => void;
  showToast: (message: string, tone?: "success" | "error" | "info", duration?: number, key?: string) => void;
  showErrorToast: (error: unknown, key?: string, duration?: number) => void;
  copyText: (value: string, successMessage: string) => Promise<void>;
};

function appendComposerText(current: string, addition: string): string {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return current;
  }

  const trimmedCurrent = current.trim();
  return trimmedCurrent ? `${trimmedCurrent}\n\n${trimmedAddition}` : trimmedAddition;
}

function saveThreadScrollPosition(threadId: string | null, element: HTMLDivElement, setFollowRun: (updater: (current: boolean) => boolean) => void) {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  const isNearBottom = remaining < 32;
  if (threadId) {
    threadScrollPositions.set(threadId, { top: element.scrollTop, follow: isNearBottom });
  }
  setFollowRun((current) => (current === isNearBottom ? current : isNearBottom));
  return isNearBottom;
}

export function ThreadSurface({
  threadId,
  onPreviewMedia,
  onOpenThread,
  onDeleteThread,
  onDeleteProof,
  composerPrefill,
  onComposerPrefillConsumed,
  showToast,
  showErrorToast,
  copyText
}: ThreadSurfaceProps) {
  const shell = useShellSnapshot();
  const runtime = useRuntimeSnapshot();
  const knownImages = useKnownImages();
  const activeThread = useThreadDetail(threadId);
  const [threadDraft, setThreadDraft] = useState("");
  const [threadAttachments, setThreadAttachments] = useState<FileReference[]>([]);
  const [threadUploadingAttachments, setThreadUploadingAttachments] = useState(0);
  const [threadDragActive, setThreadDragActive] = useState(false);
  const [pendingThreadRequest, setPendingThreadRequest] = useState<{
    threadId: string;
    text: string;
    sentAt: number;
  } | null>(null);
  const [followRun, setFollowRun] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showThreadRuntime, setShowThreadRuntime] = useState(false);
  const [showThreadProofs, setShowThreadProofs] = useState(false);
  const [expandedSystemItems, setExpandedSystemItems] = useState<Record<string, boolean>>({});
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const [busyStackId, setBusyStackId] = useState<string | null>(null);
  const [busyServiceId, setBusyServiceId] = useState<string | null>(null);
  const [activeJumpId, setActiveJumpId] = useState<string | null>(null);
  const runScrollRef = useRef<HTMLDivElement | null>(null);
  const runTimelineScrollRef = useRef<HTMLDivElement | null>(null);
  const runScrollTopRef = useRef(0);
  const restoredThreadScrollRef = useRef<string | null>(null);
  const restoredThreadPanelRef = useRef<string | null>(null);
  const skipNextPanelStateSaveRef = useRef(false);
  const threadTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadFileInputRef = useRef<HTMLInputElement | null>(null);
  const threadDraftPersistTimerRef = useRef<number | null>(null);
  const jumpFlashTimerRef = useRef<number | null>(null);
  const lastAppliedPrefillIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const nextThreadId = threadId;
    const panelState = nextThreadId ? threadPanelStates.get(nextThreadId) : null;
    setThreadDraft(nextThreadId ? readStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${nextThreadId}`) : "");
    setThreadAttachments([]);
    setFollowRun(nextThreadId ? (threadScrollPositions.get(nextThreadId)?.follow ?? true) : true);
    setShowTimeline(panelState?.showTimeline ?? false);
    setShowThreadRuntime(panelState?.showThreadRuntime ?? false);
    setShowThreadProofs(panelState?.showThreadProofs ?? false);
    setExpandedSystemItems(panelState?.expandedSystemItems ?? {});
    setExpandedToolGroups(panelState?.expandedToolGroups ?? {});
    restoredThreadPanelRef.current = nextThreadId;
    skipNextPanelStateSaveRef.current = true;
  }, [threadId]);

  useEffect(() => {
    if (!threadId || restoredThreadPanelRef.current !== threadId) {
      return;
    }
    if (skipNextPanelStateSaveRef.current) {
      skipNextPanelStateSaveRef.current = false;
      return;
    }
    threadPanelStates.set(threadId, {
      showTimeline,
      showThreadRuntime,
      showThreadProofs,
      expandedSystemItems,
      expandedToolGroups
    });
  }, [expandedSystemItems, expandedToolGroups, showThreadProofs, showThreadRuntime, showTimeline, threadId]);

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
    const scroller = runScrollRef.current;
    if (!scroller || !threadId || activeThread?.id !== threadId || restoredThreadScrollRef.current !== threadId) {
      return;
    }

    const saveScrollPosition = () => {
      runScrollTopRef.current = scroller.scrollTop;
      saveThreadScrollPosition(threadId, scroller, setFollowRun);
    };
    scroller.addEventListener("scroll", saveScrollPosition, { passive: true });
    return () => scroller.removeEventListener("scroll", saveScrollPosition);
  }, [activeThread?.id, threadId]);

  useEffect(() => {
    return () => {
      if (jumpFlashTimerRef.current !== null) {
        window.clearTimeout(jumpFlashTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      !activeThread ||
      !composerPrefill ||
      composerPrefill.target.kind !== "thread" ||
      composerPrefill.target.threadId !== activeThread.id ||
      lastAppliedPrefillIdRef.current === composerPrefill.id
    ) {
      return;
    }

    lastAppliedPrefillIdRef.current = composerPrefill.id;
    setThreadAttachments((current) =>
      current.some((entry) => entry.id === composerPrefill.attachment.id) ? current : [...current, composerPrefill.attachment]
    );
    if (composerPrefill.attachment.mimeType.startsWith("image/")) {
      mergeKnownImages([composerPrefill.attachment]);
    }
    setThreadDraft((current) => appendComposerText(current, composerPrefill.text));
    setFollowRun(true);
    onComposerPrefillConsumed(composerPrefill.id);
    showToast("Annotated proof added to the thread composer", "success", 2200);
  }, [activeThread, composerPrefill, onComposerPrefillConsumed, showToast]);

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

  async function uploadThreadAttachments(files: FileList | File[]) {
    const uploadFiles = [...files];
    if (uploadFiles.length === 0) {
      return;
    }

    setThreadUploadingAttachments((current) => current + uploadFiles.length);
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
      setThreadAttachments((current) => [...current, ...uploaded]);
      showToast(uploadFiles.length === 1 ? "File attached" : `${uploadFiles.length} files attached`);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setThreadUploadingAttachments((current) => Math.max(0, current - uploadFiles.length));
    }
  }

  async function sendThreadMessage() {
    if (!activeThread) {
      return;
    }

    const text = threadDraft.trim();
    const composerAttachments = [...threadAttachments];
    if (!text && composerAttachments.length === 0) {
      return;
    }

    const messageSummary = text || formatAttachmentSummary(composerAttachments.length);
    setThreadDraft("");
    setThreadAttachments([]);
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
        imageReferenceIds: composerAttachments.filter((item) => item.mimeType.startsWith("image/")).map((item) => item.id),
        fileReferenceIds: composerAttachments.filter((item) => !item.mimeType.startsWith("image/")).map((item) => item.id)
      });
    } catch (error) {
      setPendingThreadRequest((current) => (current?.threadId === activeThread.id && current.text === messageSummary ? null : current));
      setThreadDraft((current) => (current.trim().length === 0 ? text : current));
      setThreadAttachments((current) => (current.length === 0 ? composerAttachments : current));
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

  function toggleSystemItemExpanded(itemId: string) {
    setExpandedSystemItems((current) => ({
      ...current,
      [itemId]: !current[itemId]
    }));
  }

  function toggleToolGroupExpanded(groupId: string) {
    setExpandedToolGroups((current) => ({
      ...current,
      [groupId]: !current[groupId]
    }));
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
      saveThreadScrollPosition(threadId, scroller, setFollowRun);
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

  type RunConversationRow =
    | { id: string; kind: "item"; item: (typeof activeRunItems)[number] }
    | { id: string; kind: "toolGroup"; turnId: string; at: number; items: Array<(typeof activeRunItems)[number]> }
    | { id: string; kind: "pending"; text: string }
    | { id: string; kind: "working" };

  const runConversationRows = useMemo(
    () => {
      const rows: RunConversationRow[] = [];

      if (activeThread) {
        for (const turn of activeThread.turns) {
          const turnItems = turn.items
            .filter(shouldRenderItem)
            .map((item) => ({ ...item, turnId: turn.id, turnStartedAt: turn.startedAt }));
          if (turnItems.length === 0) {
            continue;
          }

          const systemItems = turnItems.filter((item) => itemTone(item.type) === "system");
          const settled = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
          const shouldCollapseSystemItems =
            settled && systemItems.length > 0 && turnItems.some((item) => item.type === "agentMessage");

          if (!shouldCollapseSystemItems) {
            rows.push(...turnItems.map((item) => ({ id: item.id, kind: "item" as const, item })));
            continue;
          }

          const anchorItemId =
            [...turnItems].reverse().find((item) => item.type === "agentMessage")?.id ??
            [...turnItems].reverse().find((item) => itemTone(item.type) !== "system")?.id ??
            null;

          for (const item of turnItems) {
            if (itemTone(item.type) === "system") {
              continue;
            }

            rows.push({ id: item.id, kind: "item", item });

            if (anchorItemId && item.id === anchorItemId) {
              rows.push({
                id: `tool-group-${turn.id}`,
                kind: "toolGroup",
                turnId: turn.id,
                at: systemItems.at(-1)?.at ?? item.at,
                items: systemItems
              });
            }
          }
        }
      }

      if (showPendingThreadEntry && pendingThreadRequest) {
        rows.push({ id: `pending-${pendingThreadRequest.sentAt}`, kind: "pending", text: pendingThreadRequest.text });
      }

      if (showThreadWorkingIndicator) {
        rows.push({ id: `working-${activeThread?.id ?? "thread"}`, kind: "working" });
      }

      return rows;
    },
    [activeThread, pendingThreadRequest, showPendingThreadEntry, showThreadWorkingIndicator]
  );
  const deferredRows = useDeferredValue(runConversationRows);
  const renderedRowsCurrent = deferredRows === runConversationRows;
  const latestRunActivityKey = deferredRows.length > 0 ? `${deferredRows[deferredRows.length - 1].id}:${deferredRows.length}` : "empty";

  useLayoutEffect(() => {
    if (!threadId || activeThread?.id !== threadId || !renderedRowsCurrent || restoredThreadScrollRef.current === threadId) {
      return;
    }

    const scroller = runScrollRef.current;
    if (!scroller || deferredRows.length === 0) {
      return;
    }

    const saved = threadScrollPositions.get(threadId);
    if (saved) {
      scroller.scrollTop = Math.min(saved.top, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      runScrollTopRef.current = scroller.scrollTop;
      setFollowRun((current) => (current === saved.follow ? current : saved.follow));
    } else {
      scrollElementToLatest(scroller);
      runScrollTopRef.current = scroller.scrollTop;
    }
    restoredThreadScrollRef.current = threadId;
  }, [activeThread?.id, deferredRows.length, renderedRowsCurrent, threadId]);

  useEffect(() => {
    if (!followRun || !runScrollRef.current || activeThread?.id !== threadId || !renderedRowsCurrent) {
      return;
    }

    const scheduledThreadId = threadId;
    const frameId = requestAnimationFrame(() => {
      if (
        scheduledThreadId !== threadId ||
        scheduledThreadId !== activeThread?.id ||
        threadScrollPositions.get(scheduledThreadId)?.follow === false
      ) {
        return;
      }
      scrollElementToLatest(runScrollRef.current);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeThread?.id, followRun, latestRunActivityKey, renderedRowsCurrent, threadId]);

  useEffect(() => {
    const scroller = runScrollRef.current;
    if (!scroller || !followRun || activeThread?.id !== threadId || !renderedRowsCurrent) {
      return;
    }

    const scheduledThreadId = threadId;
    const keepLatestVisible = () => {
      if (
        scheduledThreadId !== threadId ||
        scheduledThreadId !== activeThread?.id ||
        threadScrollPositions.get(scheduledThreadId)?.follow === false
      ) {
        return;
      }
      scrollElementToLatest(scroller);
    };
    const observer = new ResizeObserver(keepLatestVisible);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) {
      observer.observe(content);
    }
    const frameId = requestAnimationFrame(keepLatestVisible);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [activeThread?.id, followRun, renderedRowsCurrent, threadId]);

  const messageImages = useMemo(
    () =>
      buildMessageImageLookup(
        activeRunItems.map((item) => ({
          id: item.id,
          text: item.text || "",
          includeImages: item.type === "userMessage"
        })),
        knownImages
      ),
    [activeRunItems, knownImages]
  );

  const activeThreadStacks =
    activeThread && runtime ? runtime.stacks.filter((stack) => stack.threadId === activeThread.id && stack.status !== "stopped") : [];
  const activeThreadPreviews =
    activeThread && runtime ? runtime.previews.filter((lease) => lease.threadId === activeThread.id && lease.status !== "stopped") : [];
  const activeThreadServices =
    activeThread && runtime ? runtime.services.filter((service) => service.threadId === activeThread.id && service.status !== "stopped") : [];
  const activeThreadPreviewProofs =
    activeThread && runtime
      ? runtime.previewProofsByThreadId[activeThread.id] ??
        (runtime.latestPreviewProofsByThreadId[activeThread.id] ? [runtime.latestPreviewProofsByThreadId[activeThread.id]!] : [])
      : [];
  const activeThreadPreviewVerification =
    activeThreadPreviewProofs[0]?.verification ??
    activeThreadPreviews.find((lease) => Boolean(lease.lastVerification))?.lastVerification ??
    null;
  const activeThreadRuntimeLeaseCount = activeThreadStacks.length + activeThreadPreviews.length + activeThreadServices.length;

  if (!shell || !runtime || !activeThread) {
    return <div className="workspace-panel"><div className="empty">This run is open, but its turn history has not loaded yet.</div></div>;
  }

  const codexEffortOptions =
    shell.codex.compose.availableModels.find((model) => model.id === shell.codex.compose.model)?.supportedReasoningEfforts ?? [];

  function renderSystemStrip(item: (typeof activeRunItems)[number]) {
    const imageState = messageImages[item.id] ?? { displayText: item.text || "Running shell command", images: [], files: [] };
    const systemText = imageState.displayText || "Running shell command";
    const isExpanded = Boolean(expandedSystemItems[item.id]);

    return (
      <article id={`run-message-${item.id}`} className={`system-strip${activeJumpId === item.id ? " is-jump-target" : ""}`}>
        <div className="system-strip-shell">
          <button
            className="system-strip-toggle"
            type="button"
            aria-expanded={isExpanded}
            onClick={() => toggleSystemItemExpanded(item.id)}
          >
            <span className="system-strip-head">
              <span className="system-strip-label">{itemLabel(item.type)}</span>
              <span className="system-strip-head-meta">
                <span>{formatJumpLabel(item.at)}</span>
                <span className="system-strip-expand" aria-hidden="true">
                  {isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                </span>
              </span>
            </span>
            <span className={`system-strip-body${isExpanded ? " is-expanded" : ""}`}>{systemText}</span>
          </button>
          <button
            className="system-strip-copy"
            type="button"
            onClick={() => void copyText(systemText, "Message copied")}
            aria-label="Copy activity"
            title="Copy activity"
          >
            <CopyIcon />
          </button>
        </div>
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
      </article>
    );
  }

  return (
    <div className="workspace-panel">
      <div className="thread-toolbar">
        <div className="thread-toolbar-group">
          {activeThreadPreviewVerification ? (
            <div className="conversation-disclosure thread-toolbar-disclosure">
              <button
                className={`conversation-toggle thread-toolbar-toggle${showThreadProofs ? " is-active" : ""}`}
                onClick={() => {
                  setShowThreadProofs((current) => {
                    const next = !current;
                    if (next) {
                      setShowThreadRuntime(false);
                    }
                    return next;
                  });
                }}
                type="button"
              >
                <span className="conversation-toggle-icon" aria-hidden="true">
                  {showThreadProofs ? <ChevronUpIcon /> : <ChevronDownIcon />}
                </span>
                <span className="conversation-toggle-label">{showThreadProofs ? "Hide proof" : "Show proof"}</span>
                <span className="conversation-toggle-count">{activeThreadPreviewProofs.length || 1}</span>
              </button>
              {showThreadProofs ? (
                <div className="conversation-disclosure-panel runtime-disclosure-panel thread-proof-panel">
                  <div className="thread-proof-list">
                    {(activeThreadPreviewProofs.length > 0
                      ? activeThreadPreviewProofs.map((proof) => ({ proof, verification: proof.verification }))
                      : activeThreadPreviewVerification
                        ? [{ proof: null, verification: activeThreadPreviewVerification }]
                        : []
                    ).map(({ proof, verification }) => (
                      <PreviewVerificationSummary
                        key={verification.runId}
                        proof={proof}
                        verification={verification}
                        onPreviewArtifact={onPreviewMedia}
                        onResourceUnavailable={(message) => showToast(message, "error", 5000)}
                        onDeleteProof={proof ? onDeleteProof : undefined}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {activeThreadRuntimeLeaseCount > 0 ? (
            <div className="conversation-disclosure thread-toolbar-disclosure">
              <button
                className={`conversation-toggle thread-toolbar-toggle${showThreadRuntime ? " is-active" : ""}`}
                onClick={() => {
                  setShowThreadRuntime((current) => {
                    const next = !current;
                    if (next) {
                      setShowThreadProofs(false);
                    }
                    return next;
                  });
                }}
                type="button"
              >
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
                    busyServiceId={busyServiceId}
                    onFocusThread={(nextThreadId) => {
                      if (nextThreadId) {
                        onOpenThread(nextThreadId);
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
          <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onDeleteThread(activeThread.id)} aria-label="Delete thread" title="Delete thread">
            <TrashIcon />
          </button>
        </div>
      </div>

      <div className={`workspace-body ${showTimeline ? "is-detail-open" : "is-detail-closed"}`}>
        <section className="conversation-pane conversation-pane-full">
          <div
            ref={runScrollRef}
            className="conversation-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              runScrollTopRef.current = element.scrollTop;
              if (activeThread?.id === threadId && restoredThreadScrollRef.current === threadId) {
                saveThreadScrollPosition(threadId, element, setFollowRun);
              }
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

                  if (row.kind === "toolGroup") {
                    const isExpanded = Boolean(expandedToolGroups[row.id]);
                    const preview = row.items
                      .slice(0, 3)
                      .map((item) => {
                        const imageState = messageImages[item.id] ?? { displayText: item.text || "Running shell command" };
                        const displayText = (imageState.displayText || "Running shell command").replace(/\s+/g, " ").trim();
                        return `${itemLabel(item.type)}: ${displayText}`;
                      })
                      .join(" • ");

                    return (
                      <div key={row.id} className="conversation-row is-system">
                        <article id={`run-message-${row.id}`} className="tool-group-strip">
                          <button
                            className="tool-group-toggle"
                            type="button"
                            aria-expanded={isExpanded}
                            onClick={() => toggleToolGroupExpanded(row.id)}
                          >
                            <span className="tool-group-head">
                              <span className="tool-group-label">Tool calls</span>
                              <span className="tool-group-head-meta">
                                <span>{`${row.items.length} ${row.items.length === 1 ? "call" : "calls"}`}</span>
                                <span>{formatJumpLabel(row.at)}</span>
                                <span className="tool-group-expand" aria-hidden="true">
                                  {isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                                </span>
                              </span>
                            </span>
                            <span className="tool-group-preview">{preview}</span>
                          </button>
                          {isExpanded ? (
                            <div className="tool-group-panel">
                              {row.items.map((item) => (
                                <div key={item.id} className="tool-group-item">
                                  {renderSystemStrip(item)}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      </div>
                    );
                  }

                  const tone = itemTone(row.item.type);
                  const isSystemItem = tone === "system";
                  const rowToneClass = tone === "user" ? "is-user" : isSystemItem ? "is-system" : "is-assistant";
                  const imageState = messageImages[row.id] ?? { displayText: row.item.text || "Running shell command", images: [], files: [] };
                  const systemText = imageState.displayText || "Running shell command";

                  if (isSystemItem) {
                    return (
                      <div key={row.id} className={`conversation-row ${rowToneClass}`}>
                        {renderSystemStrip(row.item)}
                      </div>
                    );
                  }

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
                          <MarkdownMessage text={systemText} onPreviewMedia={onPreviewMedia} onResourceUnavailable={(message) => showToast(message, "error", 5000)} />
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
              if (isFileDrag(event)) {
                event.preventDefault();
                setThreadDragActive(true);
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
              setThreadDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setThreadDragActive(false);
              if (!isFileDrag(event)) {
                return;
              }
              void uploadThreadAttachments(event.dataTransfer.files);
            }}
          >
            <input ref={threadFileInputRef} type="file" accept={FILE_UPLOAD_ACCEPT} multiple hidden onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) {
                void uploadThreadAttachments(files);
              }
              event.target.value = "";
            }} />
            {threadAttachments.length > 0 || threadUploadingAttachments > 0 ? (
              <div>
                {threadAttachments.length > 0 ? (
                  <div className="composer-attachments composer-attachments-static">
                    {threadAttachments.map((attachment) => (
                      <div key={attachment.id} className="composer-attachment">
                        {attachment.mimeType.startsWith("image/") ? (
                          <button className="composer-attachment-preview" type="button" onClick={() => onPreviewMedia({ name: attachment.name, url: attachment.url, kind: "image", downloadUrl: attachment.url })}>
                            <img src={attachment.url} alt={attachment.name} className="composer-attachment-thumb" />
                          </button>
                        ) : (
                          <button className="composer-attachment-preview" type="button" onClick={() => window.open(attachment.url, "_blank")}>
                            <span className="composer-attachment-name">File</span>
                          </button>
                        )}
                        <div className="composer-attachment-copy">
                          <button
                            className="composer-attachment-name composer-attachment-name-button"
                            type="button"
                            onClick={() =>
                              attachment.mimeType.startsWith("image/")
                                ? onPreviewMedia({ name: attachment.name, url: attachment.url, kind: "image", downloadUrl: attachment.url })
                                : window.open(attachment.url, "_blank")
                            }
                          >
                            {attachment.name}
                          </button>
                        </div>
                        <button className="composer-attachment-remove" type="button" onClick={() => setThreadAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {threadUploadingAttachments > 0 ? <div className="composer-uploading">Uploading {threadUploadingAttachments}…</div> : null}
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
                <button className="composer-add-image composer-add-image-mobile" type="button" onClick={() => threadFileInputRef.current?.click()} aria-label="Add file" title="Add file">
                  <AttachmentIcon />
                </button>
                <button className="composer-send composer-send-mobile" onClick={() => void sendThreadMessage()} disabled={(!threadDraft.trim() && threadAttachments.length === 0) || threadUploadingAttachments > 0} aria-label="Send message">
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
                <button className="composer-add-image" type="button" onClick={() => threadFileInputRef.current?.click()} aria-label="Add file" title="Add file">
                  <AttachmentIcon />
                </button>
                <button className="composer-send composer-send-desktop" onClick={() => void sendThreadMessage()} disabled={(!threadDraft.trim() && threadAttachments.length === 0) || threadUploadingAttachments > 0} aria-label="Send message">
                  <span className="composer-send-label">Send</span>
                  <span className="composer-send-icon">
                    <SendIcon />
                  </span>
                </button>
              </div>
            </div>
            {threadDragActive ? <div className="composer-drop-note">Drop files to attach them</div> : null}
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
