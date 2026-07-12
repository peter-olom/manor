import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { CloseIcon } from "./icons";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { operatorQuestionNeedsAction, OperatorQuestionCard } from "./OperatorQuestionCard";
import { SandSpinner } from "./SandSpinner";
import { ThinkingTrace, traceDisclosureLabel } from "./ThinkingTrace";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { useLiveButlerTurn, type CompletedTrace } from "./useLiveButlerTurn";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import type { PairButlerActivityOutcome, PairDetail, PairMessage, PairModelOption, PairReviewActivity, PairTraceItem } from "../shared/pairing";
import type { FileReference } from "./api";
import type { PreviewMedia } from "./ImagePreviewModal";

type ButlerPaneProps = {
  pair: PairDetail;
  draft: string;
  busy: boolean;
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
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewImage: (media: PreviewMedia) => void;
  onPairUpdate: (pair: PairDetail) => void;
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

function shouldShowWorkLoader(pair: PairDetail): boolean {
  if (pair.butlerPendingReason) return false;
  return pair.butlerPending || pair.status === "butler_running" || pair.status === "worker_running";
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
  sendDisabled: boolean;
  model: string | null;
  availableModels: PairModelOption[];
  thinkingLevel: string;
  availableThinkingLevels: string[];
  onModelChange: (model: string) => void;
  onThinkingLevelChange: (level: string) => void;
  attachments: FileReference[];
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewImage: (media: PreviewMedia) => void;
  blockedReason: string | null;
};

export const Composer = memo(function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  sendDisabled,
  model,
  availableModels,
  thinkingLevel,
  availableThinkingLevels,
  onModelChange,
  onThinkingLevelChange,
  attachments,
  onRemoveAttachment,
  onPreviewImage,
  blockedReason
}: ComposerProps) {
  const ref = useAutoGrow(value);
  const canSubmit = Boolean(value.trim() || attachments.length > 0);
  const isMultilineDraft = value.includes("\n");
  if (blockedReason) {
    return (
      <div className="composer">
        <div className="composer-blocked" role="status">{blockedReason}</div>
      </div>
    );
  }
  return (
    <div className="composer">
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label="Composer attachments">
          {attachments.map((attachment) => {
            const isImage = attachment.mimeType.startsWith("image/");
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
        className="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy || sendDisabled) return;
          onSubmit();
        }}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
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
          placeholder="Message Butler…"
          rows={2}
        />
        <div className="composer-actions">
          <div className="composer-settings" aria-label="Butler settings">
            <ModelPicker
              label="Butler model"
              value={model}
              options={availableModels}
              disabled={busy}
              compact
              className="composer-model"
              onChange={onModelChange}
            />
            {availableThinkingLevels.length > 0 ? (
              <BudgetSegmented
                label="Butler thinking"
                value={thinkingLevel}
                options={availableThinkingLevels}
                disabled={busy}
                onChange={onThinkingLevelChange}
                className="composer-budget"
              />
            ) : null}
            {isMultilineDraft ? <span className="composer-hint">Ctrl/Cmd + Enter</span> : null}
          </div>
          <button className="composer-send" type="submit" disabled={busy || sendDisabled || !canSubmit}>
            {busy ? <span className="spinner" /> : <span>Send</span>}
          </button>
        </div>
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
        <span className="bubble-disclosure-icon" aria-hidden="true" />
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

const LiveBubble = memo(function LiveBubble({ text, items, pending }: LiveBubbleProps) {
  const traceItems = useMemo(() => [...items.values()].sort((a, b) => a.at - b.at), [items]);
  const trace = useMemo(() => ({
    messageId: "live",
    items: traceItems,
    durationMs: 0,
    startedAt: 0,
    completedAt: 0
  }), [traceItems]);
  return (
    <article className={`bubble is-butler ${pending ? "is-live" : "is-live-complete"}`}>
      <header className="bubble-head">
        <span>Butler</span>
        <time className="bubble-time">{pending ? "thinking" : "writing"}</time>
      </header>
      {traceItems.length > 0 ? (
        pending ? (
          <TraceDisclosure items={traceItems} defaultOpen label={liveActivityLabel(traceItems)} />
        ) : (
          <CompletedTraceBubble trace={trace} />
        )
      ) : null}
      {text ? <Markdown className="bubble-body" text={text} /> : null}
    </article>
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
    <article className={`bubble is-butler is-loader${failed ? " is-failed" : ""}`} aria-label={failed ? "Butler stopped with an error" : "Butler is working"}>
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
      {failed && detail ? (
        <details className="review-diagnostics" open>
          <summary>Exact failure details</summary>
          <Markdown className="trace-body" text={detail} />
        </details>
      ) : null}
      {items.length > 0 ? (
        <TraceDisclosure items={items} defaultOpen label={failed ? "Activity and tool details" : liveActivityLabel(items)} />
      ) : null}
    </article>
  );
});

const REVIEW_STAGE_LABELS: Record<PairReviewActivity["stage"], string> = {
  queued: "Review queued",
  preparing: "Preparing isolated review",
  reviewing_changes: "Reviewing the Worker change",
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
      <p className="review-activity-model">{[review.modelProvider, review.modelId, review.thinkingLevel].filter(Boolean).join(" · ")}</p>
      {review.lastActivity ? (
        <p className="review-activity-last">
          {review.lastActivity}
          {review.lastActivityAt ? <time> · {formatTime(review.lastActivityAt)}</time> : null}
        </p>
      ) : null}
      {diagnosticHistory ? (
        <details className="review-diagnostics" open={review.state === "blocked"}>
          <summary>{review.state === "blocked" ? "Why review stopped" : "Review failure history"}</summary>
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
};

const Bubble = memo(function Bubble({ message, liveTrace, pairId, onPairUpdate, activeQuestionMessageId }: BubbleProps) {
  const role = message.role === "user" ? "user" : message.role === "worker" ? "worker" : message.role === "butler" ? "butler" : "system";
  if (message.metadata.kind === "work-loader") {
    return <WorkLoaderBubble items={[]} />;
  }
  const persistedTrace = message.trace && message.trace.length > 0
    ? { messageId: message.id, items: message.trace, durationMs: 0, startedAt: message.at, completedAt: message.at }
    : null;
  const trace = liveTrace ?? persistedTrace;
  return (
    <article className={`bubble is-${role}${message.question ? " has-question" : ""}`}>
      <header className="bubble-head">
        <span>{roleLabel(message.role)}</span>
        <time className="bubble-time">{formatTime(message.at)}</time>
      </header>
      {trace ? <CompletedTraceBubble trace={trace} /> : null}
      {message.question ? (
        <OperatorQuestionCard pairId={pairId} messageId={message.id} question={message.question} onPairUpdate={onPairUpdate} active={message.id === activeQuestionMessageId} />
      ) : (
        <Markdown className="bubble-body" text={message.text} />
      )}
      {message.sourceThreadId ? <footer className="bubble-foot">thread {shortId(message.sourceThreadId)}</footer> : null}
    </article>
  );
});

export function ButlerPane({
  pair,
  draft,
  busy,
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
  onRemoveAttachment,
  onPreviewImage,
  onPairUpdate
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
  const showLoader = shouldShowWorkLoader(pair) && !pair.review;
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
  const lastMessageIsButler = lastMessage?.role === "butler";
  const lastMessageCoversLive = lastMessageIsButler
    && live.state.completedAt !== null
    && lastMessage !== undefined
    && lastMessage.at >= live.state.completedAt;
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
  const showWorkBubble = showLoader || activityFailed || (liveStreaming && visibleActivityItems.length > 0 && !showLiveBubble && !lastMessageCoversLive);
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
  let activeQuestionMessageId: string | null = null;
  for (let index = pair.messages.length - 1; index > lastUserMessageIndex; index -= 1) {
    const message = pair.messages[index];
    if (message?.question && operatorQuestionNeedsAction(message.question)) {
      activeQuestionMessageId = message.id;
      break;
    }
  }
  const hasOpenQuestion = Boolean(activeQuestionMessageId);
  const hasButlerReplyAfterLastUser = pair.messages.slice(lastUserMessageIndex + 1).some((message) => message.role === "butler");
  const orphanActivityTrace = !hasButlerReplyAfterLastUser && !liveStreaming && !activityFailed
    ? live.completedTraces.at(-1) ?? completedTraceFromItems(`activity-${pair.id}`, pair.butlerActivity)
    : null;
  const orphanActivityOutcome = !hasButlerReplyAfterLastUser && !liveStreaming && !activityFailed && activityOutcome && (orphanActivityTrace || activityStopped)
    ? activityOutcome
    : null;
  const totalCount = pair.messages.length + (showWorkBubble ? 1 : 0) + (showBlockedCloseout ? 1 : 0) + (showLiveBubble ? 1 : 0) + (pair.review ? 1 : 0) + (orphanActivityOutcome ? 1 : 0);
  const bottomKey = `${lastMessageId}:${totalCount}:${live.state.assistantText.length}:${live.state.items.size}:${lastMessageAt}`;

  const { ref, onScroll, isPinned, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({ bottomKey, resetKey: pair.id });

  return (
    <section className="pane" aria-label="Butler lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Butler</h2>
          <span className="pane-sub">{pair.messages.length} messages · {shortId(pair.id)}</span>
        </div>
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
        {pair.messages.map((message) => (
          <Bubble key={message.id} message={message} liveTrace={liveTraceByMessageId.get(message.id)} pairId={pair.id} onPairUpdate={onPairUpdate} activeQuestionMessageId={activeQuestionMessageId} />
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
        {orphanActivityOutcome ? <ActivityOnlyBubble trace={orphanActivityTrace} outcome={orphanActivityOutcome} /> : null}
        <JumpToLatest
          count={unreadCount}
          onClick={() => {
            scrollToBottom("smooth");
          }}
        />
      </div>
      {(pair.compose?.butler?.availableModels.length ?? 0) === 0 ? (
        <div className="empty-state">
          <p>Connect a provider before messaging Butler.</p>
          <button className="button is-primary" type="button" onClick={onOpenProviderSettings}>Open provider settings</button>
        </div>
      ) : <Composer
        value={draft}
        onChange={onDraft}
        onSubmit={onSend}
        busy={busy}
        sendDisabled={sendDisabled}
        model={pair.compose?.butler?.model ?? null}
        availableModels={pair.compose?.butler?.availableModels ?? []}
        thinkingLevel={pair.compose?.butler?.thinkingLevel ?? "medium"}
        availableThinkingLevels={pair.compose?.butler?.availableThinkingLevels ?? []}
        onModelChange={onButlerModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        onPreviewImage={onPreviewImage}
        blockedReason={hasOpenQuestion ? "Answer Butler’s open question above to continue." : null}
      />}
    </section>
  );
}
