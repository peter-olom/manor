import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BudgetSegmented } from "./BudgetSegmented";
import { JumpToLatest } from "./JumpToLatest";
import { Markdown } from "./Markdown";
import { ModelSelect } from "./ModelSelect";
import { SandSpinner } from "./SandSpinner";
import { ThinkingTrace, traceDisclosureLabel } from "./ThinkingTrace";
import { useAnchoredScroll } from "./useAnchoredScroll";
import { useLiveButlerTurn, type CompletedTrace } from "./useLiveButlerTurn";

import type { ProviderRuntimeLivePatch } from "../shared/provider-runtime";
import { DEFAULT_THINKING_LEVELS } from "../shared/pairing";
import type { PairDetail, PairMessage, PairModelOption, PairTraceItem } from "../shared/pairing";

const BUTLER_THREAD_ID = "butler";

type ButlerPaneProps = {
  pair: PairDetail;
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onLoadOlder: () => void;
  onButlerPatch: ((patch: ProviderRuntimeLivePatch) => void) | null;
  onThinkingLevelChange: (level: string) => void;
  onButlerModelChange: (model: string) => void;
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
  if (role === "worker") return "Codex";
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
  model: string | null;
  availableModels: PairModelOption[];
  thinkingLevel: string;
  availableThinkingLevels: string[];
  onModelChange: (model: string) => void;
  onThinkingLevelChange: (level: string) => void;
};

const Composer = memo(function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  model,
  availableModels,
  thinkingLevel,
  availableThinkingLevels,
  onModelChange,
  onThinkingLevelChange
}: ComposerProps) {
  const ref = useAutoGrow(value);
  return (
    <div className="composer">
      <form
        className="composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || busy) return;
          onSubmit();
        }}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (value.trim() && !busy) onSubmit();
            }
          }}
          placeholder="Message Butler…"
          rows={2}
        />
        <div className="composer-actions">
          <div className="composer-settings" aria-label="Butler settings">
            <ModelSelect
              label="Butler model"
              value={model}
              options={availableModels}
              disabled={busy}
              onChange={onModelChange}
              className="is-compact composer-model"
            />
            <BudgetSegmented
              label="Butler thinking"
              value={thinkingLevel}
              options={availableThinkingLevels}
              disabled={busy}
              onChange={onThinkingLevelChange}
              className="composer-budget"
            />
          </div>
          <button className="composer-send" type="submit" disabled={busy || !value.trim()}>
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

const CompletedTraceBubble = memo(function CompletedTraceBubble({ trace, defaultOpen = false }: CompletedTraceBubbleProps) {
  const label = useMemo(() => traceDisclosureLabel(trace.items), [trace.items]);
  return (
    <details className="bubble-disclosure" {...(defaultOpen ? { open: true } : {})}>
      <summary>
        <span className="bubble-disclosure-icon" aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <ThinkingTrace items={trace.items} />
    </details>
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
          <ThinkingTrace items={traceItems} />
        ) : (
          <CompletedTraceBubble trace={trace} />
        )
      ) : null}
      {text ? <Markdown className="bubble-body" text={text} /> : null}
    </article>
  );
});

type BubbleProps = {
  message: PairMessage;
  liveTrace?: CompletedTrace;
};

const Bubble = memo(function Bubble({ message, liveTrace }: BubbleProps) {
  const role = message.role === "user" ? "user" : message.role === "worker" ? "worker" : message.role === "butler" ? "butler" : "system";
  if (message.metadata.kind === "work-loader") {
    return (
      <article className="bubble is-butler is-loader" aria-label="Butler is working">
        <span className="working-indicator" aria-live="polite">
          <span className="working-indicator-label">Butler</span>
          <SandSpinner />
        </span>
      </article>
    );
  }
  const persistedTrace = message.trace && message.trace.length > 0
    ? { messageId: message.id, items: message.trace, durationMs: 0, startedAt: message.at, completedAt: message.at }
    : null;
  const trace = liveTrace ?? persistedTrace;
  return (
    <article className={`bubble is-${role}`}>
      <header className="bubble-head">
        <span>{roleLabel(message.role)}</span>
        <time className="bubble-time">{formatTime(message.at)}</time>
      </header>
      {trace ? <CompletedTraceBubble trace={trace} /> : null}
      <Markdown className="bubble-body" text={message.text} />
      {message.sourceThreadId ? <footer className="bubble-foot">thread {shortId(message.sourceThreadId)}</footer> : null}
    </article>
  );
});

export function ButlerPane({
  pair,
  draft,
  busy,
  onDraft,
  onSend,
  onLoadOlder,
  onButlerPatch,
  onThinkingLevelChange,
  onButlerModelChange
}: ButlerPaneProps) {
  const live = useLiveButlerTurn(BUTLER_THREAD_ID);
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
    if (live.state.status === "idle" || live.state.status === "streaming") return;
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
  const showLoader = shouldShowWorkLoader(pair);
  const showBlockedCloseout = Boolean(pair.butlerPendingReason);
  const liveStreaming = live.state.status === "streaming" || live.state.status === "completed";
  const liveHasContent = live.state.assistantText.length > 0 || live.state.items.size > 0;
  const lastMessage = pair.messages.at(-1);
  const lastMessageIsButler = lastMessage?.role === "butler";
  const lastMessageCoversLive = lastMessageIsButler
    && live.state.completedAt !== null
    && lastMessage !== undefined
    && lastMessage.at >= live.state.completedAt;
  const showLiveBubble = liveStreaming && liveHasContent && !lastMessageCoversLive;
  const liveItems = useMemo(() => [...live.state.items.values()].sort((a, b) => a.at - b.at), [live.state.items]);
  const liveTraceForMessage = useMemo<CompletedTrace | undefined>(() => {
    if (live.completedTraces.length === 0) return undefined;
    const lastButlerIndex = (() => {
      for (let i = pair.messages.length - 1; i >= 0; i -= 1) {
        if (pair.messages[i]?.role === "butler") return i;
      }
      return -1;
    })();
    if (lastButlerIndex < 0) return undefined;
    const target = pair.messages[lastButlerIndex];
    if (!target) return undefined;
    const hasPersistedTrace = (target.trace?.length ?? 0) > 0;
    if (hasPersistedTrace) return undefined;
    return live.completedTraces[live.completedTraces.length - 1];
  }, [pair.messages, live.completedTraces]);
  const liveTraceByMessageId = useMemo(() => {
    const map = new Map<string, CompletedTrace>();
    if (liveTraceForMessage && lastMessage && lastMessage.role === "butler") {
      map.set(lastMessage.id, liveTraceForMessage);
    }
    return map;
  }, [liveTraceForMessage, lastMessage]);
  const totalCount = pair.messages.length + (showLoader ? 1 : 0) + (showBlockedCloseout ? 1 : 0) + (showLiveBubble ? 1 : 0);
  const bottomKey = `${lastMessageId}:${totalCount}:${live.state.assistantText.length}:${live.state.items.size}:${lastMessageAt}`;

  const { ref, onScroll, isPinned, unreadCount, scrollToBottom } = useAnchoredScroll<HTMLDivElement>({ bottomKey, resetKey: pair.id });

  return (
    <section className="pane" aria-label="Butler lane">
      <div className="pane-head">
        <div className="pane-head-info">
          <h2>Butler</h2>
          <span className="pane-sub">{pair.messages.length} messages · {shortId(pair.id)}</span>
        </div>
      </div>
      <div className="transcript" ref={ref} onScroll={onScroll} data-count={totalCount}>
        {pair.hasMore ? (
          <button className="button is-ghost load-more" type="button" onClick={onLoadOlder}>
            Load older
          </button>
        ) : null}
        {pair.messages.map((message) => (
          <Bubble key={message.id} message={message} liveTrace={liveTraceByMessageId.get(message.id)} />
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
          </article>
        ) : null}
        {showLoader ? (
          <article className="bubble is-butler is-loader" aria-label="Butler is working">
            <span className="working-indicator" aria-live="polite">
              <span className="working-indicator-label">Butler</span>
              <SandSpinner />
            </span>
          </article>
        ) : null}
        <JumpToLatest
          count={unreadCount}
          onClick={() => {
            scrollToBottom("smooth");
          }}
        />
      </div>
      <Composer
        value={draft}
        onChange={onDraft}
        onSubmit={onSend}
        busy={busy}
        model={pair.compose?.butler?.model ?? null}
        availableModels={pair.compose?.butler?.availableModels ?? []}
        thinkingLevel={pair.compose?.butler?.thinkingLevel ?? "medium"}
        availableThinkingLevels={pair.compose?.butler?.availableThinkingLevels ?? [...DEFAULT_THINKING_LEVELS]}
        onModelChange={onButlerModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
      />
    </section>
  );
}
