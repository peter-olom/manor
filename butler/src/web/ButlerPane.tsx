import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { AttachmentIcon, CloseIcon, SendIcon } from "./icons";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { SessionControlsButton } from "./WorkerSessionControls";
import { operatorQuestionNeedsAction, OperatorQuestionCard } from "./OperatorQuestionCard";
import { SandSpinner } from "./SandSpinner";
import { ThinkingTrace, traceDisclosureLabel } from "./ThinkingTrace";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { useLiveButlerTurn, type CompletedTrace } from "./useLiveButlerTurn";
import { providerModelRef } from "./worker-route";
import { addComposerContextItem, applyComposerSuggestion, composerItemKey, composerItemLabel, findComposerTrigger, type ComposerTriggerMatch } from "./composer-suggestions";
import { buildProjectArtifactPreview, type ProjectArtifactPreview, type ProjectArtifactPreviewTarget } from "./project-artifact-preview";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type { PairButlerActivityOutcome, PairComposerInputItem, PairComposerSuggestion, PairDetail, PairMessage, PairModelOption, PairReviewActivity, PairTraceItem } from "../shared/pairing";
import { getJson, isVisionImageFile, type FileReference } from "./api";
import type { PreviewMedia } from "./ImagePreviewModal";

type ButlerPaneProps = {
  pair: PairDetail;
  draft: string;
  composerPlaceholder?: string;
  busy: boolean;
  composerBusy: boolean;
  sendDisabled: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onLoadOlder: () => void;
  onButlerPatch: ((patch: ProviderRuntimeLivePatch) => void) | null;
  onThinkingLevelChange: (level: string) => void;
  onButlerModelChange: (model: string) => void;
  onRetryReview: () => void;
  onStopReview: () => void;
  onStopButler: () => void;
  stoppingButler: boolean;
  liveConnected: boolean;
  liveHasConnected: boolean;
  onOpenProviderSettings: () => void;
  attachments: FileReference[];
  onUploadFiles: (files: File[]) => void;
  uploadingFiles: boolean;
  uploadError: string | null;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewImage: (media: PreviewMedia) => void;
  onPreviewProjectArtifact: (target: ProjectArtifactPreviewTarget) => void;
  onPreviewProjectFile: (preview: ProjectArtifactPreview) => void;
  onPairUpdate: (pair: PairDetail) => void;
  contextItems: PairComposerInputItem[];
  onContextItemsChange: (items: PairComposerInputItem[]) => void;
};

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.split("-").at(-1) ?? value.slice(0, 8);
}

function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "butler") return "Butler";
  if (role === "worker") return "Worker";
  return "System";
}

function workLoaderMessage(pair: PairDetail): PairMessage {
  return {
    id: `${pair.id}:work-loader`,
    role: "butler",
    lane: "butler",
    text: "",
    at: pair.lastMessage?.at ?? pair.updatedAt,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: { kind: "work-loader" },
    pending: true
  };
}

export function pendingActivityOwner(pair: Pick<PairDetail, "butlerPending" | "butlerPendingReason" | "status">): "butler" | "worker" | null {
  if (pair.butlerPendingReason) return null;
  if (pair.butlerPending || pair.status === "butler_running") return "butler";
  if (pair.status === "worker_running") return "worker";
  return null;
}

function useAutoGrow(value: string, minHeight = 56) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    const next = Math.max(minHeight, element.scrollHeight);
    element.style.height = `${Math.min(next, 240)}px`;
  }, [value, minHeight]);
  return ref;
}

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  settingsDisabled: boolean;
  queueMode: boolean;
  sendDisabled: boolean;
  model: string | null;
  availableModels: PairModelOption[];
  thinkingLevel: string;
  availableThinkingLevels: string[];
  onModelChange: (model: string) => void;
  onThinkingLevelChange: (level: string) => void;
  attachments: FileReference[];
  onUploadFiles: (files: File[]) => void;
  uploadingFiles: boolean;
  uploadError: string | null;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewImage: (media: PreviewMedia) => void;
  blockedReason: string | null;
  placeholder?: string;
  pairId: string;
  contextItems: PairComposerInputItem[];
  onContextItemsChange: (items: PairComposerInputItem[]) => void;
};

type ComposerFileDragPhase = "enter" | "over" | "leave" | "drop" | "end";

export function reduceComposerFileDrag(input: {
  phase: ComposerFileDragPhase;
  depth: number;
  hasFileType: boolean;
  files: File[];
  canAttach: boolean;
}): { depth: number; active: boolean; preventDefault: boolean; dropEffect: "copy" | "none" | null; filesToUpload: File[] } {
  const accepted = input.hasFileType || (input.phase === "drop" && input.files.length > 0);
  if (input.phase === "end") {
    return { depth: 0, active: false, preventDefault: false, dropEffect: null, filesToUpload: [] };
  }
  if (input.phase === "enter" && !accepted) {
    return { depth: input.depth, active: false, preventDefault: false, dropEffect: null, filesToUpload: [] };
  }
  if (input.phase === "over") {
    return {
      depth: input.depth,
      active: input.depth > 0 && input.canAttach,
      preventDefault: accepted,
      dropEffect: accepted ? input.canAttach ? "copy" : "none" : null,
      filesToUpload: []
    };
  }
  if (input.phase === "leave") {
    const depth = Math.max(0, input.depth - 1);
    return { depth, active: depth > 0 && input.canAttach, preventDefault: input.depth > 0, dropEffect: null, filesToUpload: [] };
  }
  if (input.phase === "drop") {
    return {
      depth: 0,
      active: false,
      preventDefault: accepted,
      dropEffect: null,
      filesToUpload: accepted && input.canAttach ? input.files : []
    };
  }
  const depth = input.depth + 1;
  return { depth, active: input.canAttach, preventDefault: true, dropEffect: null, filesToUpload: [] };
}

export const Composer = memo(function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  settingsDisabled,
  queueMode,
  sendDisabled,
  model,
  availableModels,
  thinkingLevel,
  availableThinkingLevels,
  onModelChange,
  onThinkingLevelChange,
  attachments,
  onUploadFiles,
  uploadingFiles,
  uploadError,
  onRemoveAttachment,
  onPreviewImage,
  blockedReason,
  placeholder = "Message Butler…",
  pairId,
  contextItems = [],
  onContextItemsChange = () => undefined
}: ComposerProps) {
  const ref = useAutoGrow(value);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [triggerMatch, setTriggerMatch] = useState<ComposerTriggerMatch | null>(null);
  const [suggestions, setSuggestions] = useState<PairComposerSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const suggestionRequestRef = useRef(0);
  const canSubmit = Boolean(value.trim() || attachments.length > 0 || contextItems.length > 0);
  const isMultilineDraft = value.includes("\n");
  const canAttach = !busy && !uploadingFiles;
  useEffect(() => {
    if (!triggerMatch) {
      setSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }
    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;
    setSuggestionsLoading(true);
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ trigger: triggerMatch.trigger, q: triggerMatch.query });
      void getJson<{ suggestions: PairComposerSuggestion[] }>(`/api/pairs/${encodeURIComponent(pairId)}/composer-suggestions?${query}`).then((payload) => {
        if (suggestionRequestRef.current !== requestId) return;
        setSuggestions(payload.suggestions);
        setActiveSuggestion(0);
        setSuggestionsLoading(false);
      }).catch(() => {
        if (suggestionRequestRef.current === requestId) {
          setSuggestions([]);
          setSuggestionsLoading(false);
        }
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [pairId, triggerMatch]);
  const chooseSuggestion = (suggestion: PairComposerSuggestion) => {
    if (!triggerMatch) return;
    const applied = applyComposerSuggestion(value, triggerMatch, suggestion);
    onChange(applied.value);
    if (applied.inputItem) {
      onContextItemsChange(addComposerContextItem(contextItems, applied.inputItem));
    }
    setTriggerMatch(null);
    setSuggestions([]);
    setSuggestionsLoading(false);
    window.requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(applied.caret, applied.caret);
    });
  };
  const applyFileDrag = (phase: ComposerFileDragPhase, event: DragEvent<HTMLFormElement>) => {
    const transition = reduceComposerFileDrag({
      phase,
      depth: dragDepthRef.current,
      hasFileType: Array.from(event.dataTransfer.types).includes("Files"),
      files: Array.from(event.dataTransfer.files),
      canAttach
    });
    if (transition.preventDefault) event.preventDefault();
    if (transition.dropEffect) event.dataTransfer.dropEffect = transition.dropEffect;
    dragDepthRef.current = transition.depth;
    setDragActive(transition.active);
    if (transition.filesToUpload.length > 0) onUploadFiles(transition.filesToUpload);
  };
  if (blockedReason) {
    return (
      <div className="composer">
        <div className="composer-blocked" role="status">{blockedReason}</div>
      </div>
    );
  }
  return (
    <div className="composer">
      {contextItems.length > 0 ? (
        <div className="composer-context-items" aria-label="Selected context">
          {contextItems.map((item) => (
            <span className={`composer-context-chip is-${item.type}`} key={composerItemKey(item)}>
              <span>{composerItemLabel(item)}</span>
              <button type="button" onClick={() => onContextItemsChange(contextItems.filter((candidate) => composerItemKey(candidate) !== composerItemKey(item)))} aria-label={`Remove ${composerItemLabel(item)}`}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label="Composer attachments">
          {attachments.map((attachment) => {
            const isImage = isVisionImageFile(attachment.mimeType, attachment.name);
            return (
              <div key={attachment.id} className="composer-attachment">
                {isImage ? (
                  <button
                    className="composer-attachment-preview"
                    type="button"
                    onClick={() => onPreviewImage({ name: attachment.name, url: attachment.url, kind: "image", downloadUrl: attachment.url })}
                    aria-label={`Preview ${attachment.name}`}
                  >
                    <img className="composer-attachment-thumb" src={attachment.url} alt="" />
                  </button>
                ) : (
                  <span className="composer-attachment-file" aria-hidden="true">{attachment.name.split(".").pop()?.slice(0, 4) || "file"}</span>
                )}
                <span className="composer-attachment-name" title={attachment.name}>{attachment.name}</span>
                <button className="composer-attachment-remove" type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <form
        className={`composer-form${dragActive ? " is-dragging" : ""}`}
        onDragEnter={(event) => applyFileDrag("enter", event)}
        onDragOver={(event) => applyFileDrag("over", event)}
        onDragLeave={(event) => applyFileDrag("leave", event)}
        onDrop={(event) => applyFileDrag("drop", event)}
        onDragEnd={(event) => applyFileDrag("end", event)}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy || sendDisabled) return;
          onSubmit();
        }}
      >
        {dragActive ? <div className="composer-drop-target" aria-live="polite">Drop files to attach</div> : null}
        {triggerMatch ? (
          <div className="composer-suggestions" role="listbox" aria-label={`${triggerMatch.trigger} suggestions`}>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                type="button"
                role="option"
                aria-selected={index === activeSuggestion}
                className={index === activeSuggestion ? "is-active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={() => chooseSuggestion(suggestion)}
              >
                <span className="composer-suggestion-kind">{suggestion.kind}</span>
                <strong>{suggestion.label}</strong>
                {suggestion.detail ? <small>{suggestion.detail}</small> : null}
              </button>
            ))}
            {suggestions.length === 0 ? (
              <div className="composer-suggestions-empty" role="status">
                {suggestionsLoading ? "Finding matches…" : triggerMatch.trigger === "@" ? "No matching files." : triggerMatch.trigger === "$" ? "No matching skills." : "No matching commands."}
              </div>
            ) : null}
          </div>
        ) : null}
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setTriggerMatch(findComposerTrigger(event.target.value, event.target.selectionStart));
          }}
          onKeyDown={(event) => {
            if (suggestions.length > 0 && triggerMatch) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestion((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTriggerMatch(null);
                setSuggestions([]);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                chooseSuggestion(suggestions[activeSuggestion]!);
                return;
              }
            }
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              if (canSubmit && !busy && !sendDisabled) onSubmit();
              return;
            }
            if (event.shiftKey || isMultilineDraft) {
              return;
            }
            event.preventDefault();
            if (canSubmit && !busy && !sendDisabled) onSubmit();
          }}
          placeholder={placeholder}
          rows={2}
        />
        <div className="composer-actions">
          <div className="composer-settings" aria-label="Butler settings">
            <input
              ref={uploadInputRef}
              className="composer-upload-input"
              type="file"
              multiple
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length > 0) onUploadFiles(files);
              }}
            />
            <button
              className="composer-attach"
              type="button"
              disabled={!canAttach}
              onClick={() => uploadInputRef.current?.click()}
              aria-label="Attach files"
            >
              {uploadingFiles ? <span className="spinner" /> : <AttachmentIcon />}
              <span className="composer-action-label">{uploadingFiles ? "Uploading" : "Attach"}</span>
            </button>
            <ModelPicker
              label="Butler model"
              value={model}
              options={availableModels}
              disabled={settingsDisabled}
              compact
              className="composer-model"
              onChange={onModelChange}
            />
            {availableThinkingLevels.length > 0 ? (
              <BudgetSegmented
                label="Butler thinking"
                value={thinkingLevel}
                options={availableThinkingLevels}
                disabled={settingsDisabled}
                onChange={onThinkingLevelChange}
                className="composer-budget"
              />
            ) : null}
            {isMultilineDraft ? <span className="composer-hint">Ctrl/Cmd + Enter</span> : null}
          </div>
          <button className="composer-send" type="submit" disabled={busy || sendDisabled || !canSubmit} aria-label={queueMode ? "Queue message" : "Send message"}>
            {busy ? <span className="spinner" /> : <><SendIcon /><span className="composer-action-label">{queueMode ? "Queue" : "Send"}</span></>}
          </button>
        </div>
        {uploadError ? <div className="composer-upload-error" role="alert">{uploadError}</div> : null}
      </form>
    </div>
  );
});

type CompletedTraceBubbleProps = {
  trace: CompletedTrace;
  defaultOpen?: boolean;
};

type TraceDisclosureProps = {
  items: PairTraceItem[];
  defaultOpen?: boolean;
  label?: string;
};

function liveActivityLabel(items: PairTraceItem[]): string {
  return `Working through ${traceDisclosureLabel(items).replace(/^Thought for /, "")}`;
}

const TraceDisclosure = memo(function TraceDisclosure({ items, defaultOpen = false, label }: TraceDisclosureProps) {
  const summary = useMemo(() => label ?? traceDisclosureLabel(items), [items, label]);
  return (
    <details className="bubble-disclosure" {...(defaultOpen ? { open: true } : {})}>
      <summary>
        <span>{summary}</span>
      </summary>
      <ThinkingTrace items={items} />
    </details>
  );
});

const CompletedTraceBubble = memo(function CompletedTraceBubble({ trace, defaultOpen = false }: CompletedTraceBubbleProps) {
  return <TraceDisclosure items={trace.items} defaultOpen={defaultOpen} />;
});

function completedTraceFromItems(messageId: string, items: PairTraceItem[]): CompletedTrace | null {
  if (items.length === 0) return null;
  const startedAt = items.reduce((earliest, item) => Math.min(earliest, item.at), items[0]!.at);
  const completedAt = items.reduce((latest, item) => Math.max(latest, item.updatedAt ?? item.completedAt ?? item.at), startedAt);
  return { messageId, items, durationMs: Math.max(0, completedAt - startedAt), startedAt, completedAt };
}

export function durableActivitySupersedesLive(
  liveStatus: ReturnType<typeof useLiveButlerTurn>["state"]["status"],
  liveStartedAt: number | null,
  outcome: PairButlerActivityOutcome | null
): boolean {
  return liveStatus !== "idle" &&
    outcome !== null &&
    outcome.status !== "active" &&
    (outcome.completedAt ?? 0) >= (liveStartedAt ?? 0);
}

export function persistedButlerMessageCoversLive(
  message: PairMessage | undefined,
  assistantText: string,
  startedAt: number | null,
  completedAt: number | null
): boolean {
  if (message?.role !== "butler") return false;
  if (completedAt !== null && message.at >= completedAt) return true;
  const liveText = assistantText.trim();
  return liveText.length > 0 &&
    message.at >= (startedAt ?? 0) &&
    message.text.trim() === liveText;
}

export const ActivityOnlyBubble = memo(function ActivityOnlyBubble({
  trace,
  outcome
}: {
  trace: CompletedTrace | null;
  outcome: PairButlerActivityOutcome;
}) {
  const stopped = outcome.status === "interrupted" || outcome.status === "cancelled";
  return (
    <article className="bubble is-butler is-live-complete" aria-label={stopped ? "Stopped Butler activity" : "Completed Butler activity"}>
      <header className="bubble-head">
        <span>Butler</span>
        <time className="bubble-time">{stopped ? "stopped" : "complete"}</time>
      </header>
      {outcome.detail ? <Markdown className="bubble-body" text={outcome.detail} /> : null}
      {trace ? <CompletedTraceBubble trace={trace} defaultOpen={stopped} /> : null}
    </article>
  );
});

type LiveBubbleProps = {
  text: string;
  items: PairTraceItem[];
  pending: boolean;
};

export const LiveBubble = memo(function LiveBubble({ text, items, pending }: LiveBubbleProps) {
  const traceItems = useMemo(() => [...items.values()].sort((a, b) => a.at - b.at), [items]);
  const trace = useMemo(() => ({
    messageId: "live",
    items: traceItems,
    durationMs: 0,
    startedAt: 0,
    completedAt: 0
  }), [traceItems]);
  const message = (
    <article className={`bubble is-butler ${pending ? "is-live" : "is-live-complete"}`}>
      <header className="bubble-head">
        <span>Butler</span>
        <time className="bubble-time">{pending ? "thinking" : "writing"}</time>
      </header>
      {text ? <Markdown className="bubble-body" text={text} /> : null}
    </article>
  );
  if (traceItems.length === 0) return message;
  return (
    <div className="butler-turn">
      {pending ? (
        <TraceDisclosure items={traceItems} defaultOpen label={liveActivityLabel(traceItems)} />
      ) : (
        <CompletedTraceBubble trace={trace} />
      )}
      {message}
    </div>
  );
});

type WorkLoaderBubbleProps = {
  items: PairTraceItem[];
  failed?: boolean;
  detail?: string | null;
  startedAt?: number | null;
  lastUpdateAt?: number | null;
};

function shortDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export const WorkLoaderBubble = memo(function WorkLoaderBubble({ items, failed = false, detail = null, startedAt = null, lastUpdateAt = null }: WorkLoaderBubbleProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (failed || !startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [failed, startedAt]);
  const staleFor = lastUpdateAt ? Math.max(0, now - lastUpdateAt) : 0;
  return (
    <div className={`butler-activity-indicator${failed ? " is-failed" : ""}`} aria-label={failed ? "Butler stopped with an error" : "Butler is working"}>
      {items.length > 0 ? (
        <TraceDisclosure items={items} defaultOpen label={failed ? "Activity and tool details" : liveActivityLabel(items)} />
      ) : null}
      {failed && detail ? (
        <details className="review-diagnostics" open>
          <summary>Exact failure details</summary>
          <Markdown className="trace-body" text={detail} />
        </details>
      ) : null}
      <div className="butler-activity-current">
        <span className="working-indicator" aria-live="polite">
          <span className="working-indicator-label">{failed ? "Butler stopped with an error" : "Butler"}</span>
          {failed ? null : <SandSpinner />}
        </span>
        {startedAt ? (
          <span className={`working-timing${staleFor >= 30_000 ? " is-stale" : ""}`}>
            {failed ? `Stopped after ${shortDuration((lastUpdateAt ?? now) - startedAt)}` : `Working for ${shortDuration(now - startedAt)}`}
            {!failed && lastUpdateAt ? ` · last update ${shortDuration(staleFor)} ago` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export const WorkerWaitIndicator = memo(function WorkerWaitIndicator({
  worker,
  startedAt
}: {
  worker: PairDetail["worker"];
  startedAt: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const route = providerModelRef(worker?.provider, worker?.model);
  return (
    <div className="worker-wait-indicator" role="status" aria-label="Worker is working">
      <SandSpinner />
      <div className="worker-wait-copy">
        <strong>Worker is working</strong>
        {worker?.task ? <span className="worker-wait-task">{worker.task}</span> : null}
      </div>
      <span className="worker-wait-meta">
        {route ? `${route} · ` : ""}{shortDuration(now - startedAt)}
      </span>
    </div>
  );
});

const REVIEW_STAGE_LABELS: Record<PairReviewActivity["stage"], string> = {
  queued: "Review queued",
  preparing: "Preparing isolated review",
  reviewing_changes: "Reviewing the Worker result",
  supervising_closeout: "Deciding the closeout action",
  retry_wait: "Waiting to retry review",
  blocked: "Review blocked"
};

type ReviewActivityBubbleProps = {
  review: PairReviewActivity;
  blockedReason: string | null;
  busy: boolean;
  onRetry: () => void;
  onStop: () => void;
};

export const ReviewActivityBubble = memo(function ReviewActivityBubble({ review, blockedReason, busy, onRetry, onStop }: ReviewActivityBubbleProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (review.stage !== "retry_wait") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review.stage]);
  const attemptLabel = review.attempt > 0 ? `Attempt ${review.attempt} of ${review.maxAttempts}` : "Waiting to start";
  const retryRemaining = review.stage === "retry_wait" && review.nextAttemptAt
    ? Math.max(0, Math.ceil((review.nextAttemptAt - now) / 1000))
    : null;
  const currentBlocker = review.state === "blocked" ? blockedReason : null;
  const diagnosticHistory = [
    currentBlocker ? `Current blocker\n${currentBlocker}` : null,
    review.lastError && review.lastError !== currentBlocker ? `Latest review failure\n${review.lastError}` : null,
    ...review.errors.map((error) => `${formatTime(error.at)} · ${error.stage}${error.tool ? ` · ${error.tool}` : ""}\n${error.message}`)
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
  return (
    <article className={`bubble is-butler review-activity is-${review.state}`} aria-label="Adversarial review activity">
      <header className="bubble-head">
        <span>Butler review</span>
        <time className="bubble-time">{attemptLabel}</time>
      </header>
      <div className="review-activity-status" role="status">
        {review.state !== "blocked" ? <SandSpinner /> : null}
        <strong>{REVIEW_STAGE_LABELS[review.stage]}</strong>
        {retryRemaining !== null ? <span aria-hidden="true">retrying in {retryRemaining}s</span> : null}
      </div>
      <p className="review-activity-model">{[providerModelRef(review.modelProvider, review.modelId), review.thinkingLevel].filter(Boolean).join(" · ")}</p>
      {review.lastActivity ? (
        <p className="review-activity-last">
          {review.lastActivity}
          {review.lastActivityAt ? <time> · {formatTime(review.lastActivityAt)}</time> : null}
        </p>
      ) : null}
      {diagnosticHistory ? (
        <details className="review-diagnostics" open={review.state === "blocked"}>
          <summary>{review.state === "blocked" ? "Why review stopped" : "Reviewer tool history"}</summary>
          <Markdown className="trace-body" text={diagnosticHistory} />
        </details>
      ) : null}
      {review.state === "blocked" && review.retryable ? <button className="button" type="button" disabled={busy} onClick={onRetry}>Retry with current model</button> : null}
      {review.state !== "blocked" ? <button className="button is-ghost" type="button" disabled={busy} onClick={onStop}>Stop review</button> : null}
    </article>
  );
});

type BubbleProps = {
  message: PairMessage;
  liveTrace?: CompletedTrace;
  pairId: string;
  onPairUpdate: (pair: PairDetail) => void;
  activeQuestionMessageId: string | null;
  onPreviewImage: (media: PreviewMedia) => void;
  onPreviewProjectArtifact?: (target: ProjectArtifactPreviewTarget) => void;
  onPreviewProjectFile?: (preview: ProjectArtifactPreview) => void;
};

export const Bubble = memo(function Bubble({ message, liveTrace, pairId, onPairUpdate, activeQuestionMessageId, onPreviewImage, onPreviewProjectArtifact, onPreviewProjectFile }: BubbleProps) {
  const role = message.role === "user" ? "user" : message.role === "worker" ? "worker" : message.role === "butler" ? "butler" : "system";
  if (message.metadata.kind === "work-loader") {
    return <WorkLoaderBubble items={[]} />;
  }
  const persistedTrace = message.trace && message.trace.length > 0
    ? { messageId: message.id, items: message.trace, durationMs: 0, startedAt: message.at, completedAt: message.at }
    : null;
  const trace = liveTrace ?? persistedTrace;
  const messageBubble = (
    <article className={`bubble is-${role}${message.question ? " has-question" : ""}`}>
      <header className="bubble-head">
        <span>{roleLabel(message.role)}</span>
        <time className="bubble-time">{formatTime(message.at)}</time>
      </header>
      {message.question ? (
        <OperatorQuestionCard pairId={pairId} messageId={message.id} question={message.question} onPairUpdate={onPairUpdate} active={message.id === activeQuestionMessageId} />
      ) : (
        <>
          {message.text.trim() ? <Markdown className="bubble-body" text={message.text} onProjectArtifactOpen={onPreviewProjectArtifact} /> : null}
          {message.attachments?.length ? (
            <div className={`bubble-attachments${role === "butler" ? " is-presented" : ""}`} aria-label="Message attachments">
              {message.attachments.map((attachment) => {
                if (attachment.kind === "image") {
                  return (
                    <button
                      key={attachment.id}
                      className="bubble-attachment is-image"
                      type="button"
                      title={attachment.name}
                      aria-label={`Preview ${attachment.name}`}
                      onClick={() => onPreviewImage({ name: attachment.name, url: attachment.url, kind: "image", downloadUrl: attachment.downloadUrl ?? attachment.url })}
                    >
                      <img src={attachment.url} alt="" />
                    </button>
                  );
                }
                const preview = buildProjectArtifactPreview(attachment);
                if (preview && onPreviewProjectFile) {
                  return (
                    <button
                      key={attachment.id}
                      className="bubble-attachment is-file"
                      type="button"
                      title={attachment.name}
                      aria-label={`Preview ${attachment.name}`}
                      onClick={() => onPreviewProjectFile(preview)}
                    >
                      {attachment.name.split(".").pop()?.slice(0, 4) || "file"}
                    </button>
                  );
                }
                return (
                  <a
                    key={attachment.id}
                    className="bubble-attachment is-file"
                    href={attachment.downloadUrl ?? attachment.url}
                    title={attachment.name}
                    aria-label={`Download ${attachment.name}`}
                  >
                    {attachment.name.split(".").pop()?.slice(0, 4) || "file"}
                  </a>
                );
              })}
            </div>
          ) : null}
        </>
      )}
      {message.sourceThreadId ? <footer className="bubble-foot">thread {shortId(message.sourceThreadId)}</footer> : null}
    </article>
  );
  if (!trace) return messageBubble;
  return (
    <div className="butler-turn">
      <CompletedTraceBubble trace={trace} />
      {messageBubble}
    </div>
  );
});

export function findActiveOperatorQuestionMessage(messages: PairMessage[]): PairMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.question && (operatorQuestionNeedsAction(message.question) || message.question.deliveryState === "pending")) {
      return message;
    }
  }
  return null;
}

export function ButlerPane({
  pair,
  draft,
  composerPlaceholder,
  busy,
  composerBusy,
  sendDisabled,
  onDraft,
  onSend,
  onLoadOlder,
  onButlerPatch,
  onThinkingLevelChange,
  onButlerModelChange,
  onRetryReview,
  onStopReview,
  onStopButler,
  stoppingButler,
  liveConnected,
  liveHasConnected,
  onOpenProviderSettings,
  attachments,
  onUploadFiles,
  uploadingFiles,
  uploadError,
  onRemoveAttachment,
  onPreviewImage,
  onPreviewProjectArtifact,
  onPreviewProjectFile,
  onPairUpdate,
  contextItems,
  onContextItemsChange
}: ButlerPaneProps) {
  const live = useLiveButlerTurn(`butler:${pair.id}`);
  const [completedTraces, setCompletedTraces] = useState<Map<string, CompletedTrace>>(new Map());
  const lastTraceKeyRef = useRef<string>("");

  useEffect(() => {
    if (lastTraceKeyRef.current === pair.id) return;
    lastTraceKeyRef.current = pair.id;
    setCompletedTraces(new Map());
    live.reset();
  }, [pair.id, live]);

  useEffect(() => {
    const last = pair.messages.at(-1);
    if (!last) return;
    if (last.role !== "user") return;
    if (live.state.status !== "completed") return;
    live.reset();
    setCompletedTraces(new Map());
  }, [pair.messages, live]);

  useEffect(() => {
    if (!onButlerPatch) return;
    onButlerPatch(live.applyPatch);
    return () => onButlerPatch(null);
  }, [live.applyPatch, onButlerPatch]);

  useEffect(() => {
    if (live.completedTraces.length === 0) return;
    setCompletedTraces((current) => {
      const next = new Map(current);
      for (const trace of live.completedTraces) {
        next.set(trace.messageId, trace);
      }
      return next;
    });
  }, [live.completedTraces]);

  const lastMessageId = pair.messages.at(-1)?.id ?? null;
  const lastMessageAt = pair.messages.at(-1)?.at ?? 0;
  const activityOwner = pendingActivityOwner(pair);
  const showLoader = activityOwner === "butler" && !pair.review;
  const workerWaitCandidate = activityOwner === "worker" && Boolean(pair.worker) && !pair.review;
  const showBlockedCloseout = Boolean(pair.butlerPendingReason) && !pair.review;
  const liveHasTurn = live.state.status !== "idle";
  const persistedOutcomeSupersedesLive = durableActivitySupersedesLive(live.state.status, live.state.startedAt, pair.butlerActivityOutcome);
  const activityUsesLive = liveHasTurn && !persistedOutcomeSupersedesLive;
  const liveStreaming = activityUsesLive && live.state.status === "streaming";
  const activityOutcome: PairButlerActivityOutcome | null = activityUsesLive
    ? {
        status: live.state.status === "streaming" ? "active" : live.state.status,
        startedAt: live.state.startedAt ?? pair.butlerActivityOutcome?.startedAt ?? pair.updatedAt,
        completedAt: live.state.completedAt,
        detail: null
      }
    : pair.butlerActivityOutcome;
  const liveHasAssistantText = live.state.assistantText.trim().length > 0;
  const lastMessage = pair.messages.at(-1);
  const lastMessageCoversLive = persistedButlerMessageCoversLive(
    lastMessage,
    live.state.assistantText,
    live.state.startedAt,
    live.state.completedAt
  );
  const liveItems = useMemo(() => [...live.state.items.values()].sort((a, b) => a.at - b.at), [live.state.items]);
  const visibleActivityItems = activityUsesLive && liveItems.length > 0 ? liveItems : pair.butlerActivity;
  const activityFailed = activityOutcome?.status === "failed";
  const activityStopped = activityOutcome?.status === "interrupted" || activityOutcome?.status === "cancelled";
  const activityStartedAt = activityOutcome?.startedAt ?? visibleActivityItems[0]?.at ?? (showLoader ? pair.lastMessage?.at ?? pair.updatedAt : null);
  const activityLastUpdateAt = visibleActivityItems.reduce(
    (latest, item) => Math.max(latest, item.updatedAt ?? item.completedAt ?? item.at),
    activityOutcome?.completedAt ?? activityStartedAt ?? 0
  ) || null;
  const showLiveBubble = activityUsesLive && liveHasAssistantText && !lastMessageCoversLive;
  const showWorkBubble = activityFailed ||
    (showLoader && !showLiveBubble && !lastMessageCoversLive) ||
    (liveStreaming && visibleActivityItems.length > 0 && !showLiveBubble && !lastMessageCoversLive);
  const showWorkerWait = workerWaitCandidate && !showWorkBubble && !showLiveBubble && !showBlockedCloseout;
  const traceAttachment = useMemo<{ messageId: string; trace: CompletedTrace } | null>(() => {
    const lastButlerIndex = (() => {
      for (let i = pair.messages.length - 1; i >= 0; i -= 1) {
        if (pair.messages[i]?.role === "butler") return i;
      }
      return -1;
    })();
    if (lastButlerIndex < 0) return null;
    const target = pair.messages[lastButlerIndex];
    if (!target) return null;
    const latestUserAt = pair.messages.reduce((latest, message) => message.role === "user" ? Math.max(latest, message.at) : latest, 0);
    if (target.at < latestUserAt) return null;
    const hasPersistedTrace = (target.trace?.length ?? 0) > 0;
    if (hasPersistedTrace) return null;
    const liveTrace = live.completedTraces.at(-1);
    if (liveTrace) return { messageId: target.id, trace: liveTrace };
    const trace = completedTraceFromItems(target.id, pair.butlerActivity);
    return trace ? { messageId: target.id, trace } : null;
  }, [pair.messages, pair.butlerActivity, live.completedTraces]);
  const liveTraceByMessageId = useMemo(() => {
    const map = new Map<string, CompletedTrace>();
    if (traceAttachment) {
      map.set(traceAttachment.messageId, traceAttachment.trace);
    }
    return map;
  }, [traceAttachment]);
  let lastUserMessageIndex = -1;
  for (let index = pair.messages.length - 1; index >= 0; index -= 1) {
    if (pair.messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  const activeQuestionMessage = findActiveOperatorQuestionMessage(pair.messages);
  const activeQuestionMessageId = activeQuestionMessage?.id ?? null;
  const historicalMessages = activeQuestionMessage ? pair.messages.filter((message) => message.id !== activeQuestionMessage.id) : pair.messages;
  const hasButlerReplyAfterLastUser = pair.messages.slice(lastUserMessageIndex + 1).some((message) => message.role === "butler");
  const orphanActivityTrace = !hasButlerReplyAfterLastUser && !liveStreaming && !activityFailed
    ? live.completedTraces.at(-1) ?? completedTraceFromItems(`activity-${pair.id}`, pair.butlerActivity)
    : null;
  const orphanActivityOutcome = !hasButlerReplyAfterLastUser && !liveStreaming && !activityFailed && activityOutcome && (orphanActivityTrace || activityStopped)
    ? activityOutcome
    : null;
  const totalCount = pair.messages.length + (showWorkBubble ? 1 : 0) + (showWorkerWait ? 1 : 0) + (showBlockedCloseout ? 1 : 0) + (showLiveBubble ? 1 : 0) + (pair.review ? 1 : 0) + (orphanActivityOutcome ? 1 : 0);
  const bottomKey = `${lastMessageId}:${totalCount}:${live.state.assistantText.length}:${live.state.items.size}:${lastMessageAt}:${activeQuestionMessageId ?? ""}:${activeQuestionMessage?.question?.deliveryState ?? ""}`;

  const { ref, onScroll, isPinned, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({ bottomKey, resetKey: pair.id });

  return (
    <section className="pane" aria-label="Butler lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Butler</h2>
          <span className="pane-sub">{pair.messages.length} messages · {shortId(pair.id)}</span>
        </div>
        {!pair.butlerPending ? <SessionControlsButton pairId={pair.id} lane="butler" disabled={!pair.butlerReady} /> : null}
        {pair.butlerPending && !pair.review ? (
          <button className="button is-ghost" type="button" disabled={stoppingButler} onClick={onStopButler}>
            {stoppingButler ? "Stopping…" : "Stop Butler"}
          </button>
        ) : null}
      </div>
      <div className="transcript" ref={ref} onScroll={onScroll} data-count={totalCount}>
        {liveHasConnected && !liveConnected ? <div className="live-connection-warning" role="status">Live updates disconnected. Polling continues.</div> : null}
        {pair.hasMore ? (
          <button className="button is-ghost load-more" type="button" onClick={onLoadOlder}>
            Load older
          </button>
        ) : null}
        {historicalMessages.map((message) => (
          <Bubble key={message.id} message={message} liveTrace={liveTraceByMessageId.get(message.id)} pairId={pair.id} onPairUpdate={onPairUpdate} activeQuestionMessageId={activeQuestionMessageId} onPreviewImage={onPreviewImage} onPreviewProjectArtifact={onPreviewProjectArtifact} onPreviewProjectFile={onPreviewProjectFile} />
        ))}
        {showLiveBubble ? (
          <LiveBubble
            text={live.state.assistantText}
            items={liveItems}
            pending={live.state.status === "streaming"}
          />
        ) : null}
        {showBlockedCloseout ? (
          <article className="bubble is-butler" aria-label="Butler closeout is blocked">
            <header className="bubble-head">
              <span>Butler</span>
              <time className="bubble-time">blocked</time>
            </header>
            <Markdown className="bubble-body" text={pair.butlerPendingReason ?? ""} />
            {pair.butlerPendingReason?.includes("Adversarial review paused") ? <button className="button" type="button" disabled={busy} onClick={onRetryReview}>Retry with current model</button> : null}
          </article>
        ) : null}
        {pair.review ? <ReviewActivityBubble review={pair.review} blockedReason={pair.butlerPendingReason} busy={busy} onRetry={onRetryReview} onStop={onStopReview} /> : null}
        {showWorkBubble ? <WorkLoaderBubble items={showLiveBubble ? [] : visibleActivityItems} failed={activityFailed} detail={activityOutcome?.detail} startedAt={activityStartedAt} lastUpdateAt={activityLastUpdateAt} /> : null}
        {showWorkerWait ? <WorkerWaitIndicator worker={pair.worker} startedAt={pair.worker?.startedAt ?? pair.updatedAt} /> : null}
        {orphanActivityOutcome ? <ActivityOnlyBubble trace={orphanActivityTrace} outcome={orphanActivityOutcome} /> : null}
        {activeQuestionMessage?.question ? (
          <div className="operator-question-input" aria-label="Butler needs your decision">
            <div className="operator-question-input-label">Decision required</div>
            <OperatorQuestionCard pairId={pair.id} messageId={activeQuestionMessage.id} question={activeQuestionMessage.question} onPairUpdate={onPairUpdate} />
          </div>
        ) : null}
        <JumpToLatest
          count={unreadCount}
          onClick={() => {
            scrollToBottom("smooth");
          }}
        />
      </div>
      {activeQuestionMessage ? null : (pair.compose?.butler?.availableModels.length ?? 0) === 0 ? (
        <div className="empty-state">
          <p>Connect a provider before messaging Butler.</p>
          <button className="button is-primary" type="button" onClick={onOpenProviderSettings}>Open provider settings</button>
        </div>
      ) : <Composer
        value={draft}
        onChange={onDraft}
        onSubmit={onSend}
        busy={composerBusy}
        settingsDisabled={busy}
        queueMode={pair.butlerPending}
        sendDisabled={sendDisabled}
        model={pair.compose?.butler?.model ?? null}
        availableModels={pair.compose?.butler?.availableModels ?? []}
        thinkingLevel={pair.compose?.butler?.thinkingLevel ?? "medium"}
        availableThinkingLevels={pair.compose?.butler?.availableThinkingLevels ?? []}
        onModelChange={onButlerModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
        attachments={attachments}
        onUploadFiles={onUploadFiles}
        uploadingFiles={uploadingFiles}
        uploadError={uploadError}
        onRemoveAttachment={onRemoveAttachment}
        onPreviewImage={onPreviewImage}
        blockedReason={null}
        placeholder={composerPlaceholder}
        pairId={pair.id}
        contextItems={contextItems}
        onContextItemsChange={onContextItemsChange}
      />}
    </section>
  );
}
