import { isValidElement, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import manorLogoUrl from "./assets/manor-logo.svg";
import manorLogoDarkUrl from "./assets/manor-logo-dark.svg";

type ThreadStatus = "active" | "idle" | "unknown";
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ButlerThinkingLevel = "off" | ReasoningEffort;
type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "manor.butler.themePreference";
const BUTLER_DRAFT_STORAGE_KEY = "manor.butler.draft";
const THREAD_DRAFT_STORAGE_KEY_PREFIX = "manor.butler.threadDraft.";

type ModelOption = {
  id: string;
  label: string;
  provider: string | null;
  supportsReasoning: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | null;
};

type Snapshot = {
  codex: {
    connected: boolean;
    lastError: string | null;
    threads: Array<{
      id: string;
      preview: string;
      source: string;
      createdAt: number;
      updatedAt: number;
      status: ThreadStatus;
      turnCount: number;
      loaded: boolean;
      contextUsage: {
        tokens: number | null;
        contextWindow: number | null;
        percent: number | null;
      };
      compaction: {
        active: boolean;
        count: number;
        lastStartedAt: number | null;
        lastCompletedAt: number | null;
      };
    }>;
    windows: Array<{
      threadId: string;
      title: string;
      openedAt: number;
    }>;
    focusedWindowId: string | null;
    openThreads: Record<
      string,
      {
        id: string;
        preview: string;
        source: string;
        status: ThreadStatus;
        updatedAt: number;
        turnCount: number;
        contextUsage: {
          tokens: number | null;
          contextWindow: number | null;
          percent: number | null;
        };
        compaction: {
          active: boolean;
          count: number;
          lastStartedAt: number | null;
          lastCompletedAt: number | null;
        };
        turns: Array<{
          id: string;
          status: string;
          startedAt: number;
          completedAt: number | null;
          items: Array<{
            id: string;
            type: string;
            status: string;
            text: string;
            at: number;
          }>;
        }>;
        eventLog: Array<{
          at: number;
          method: string;
          summary: string;
        }>;
      }
    >;
    compose: {
      model: string | null;
      effort: ReasoningEffort | null;
      availableModels: ModelOption[];
    };
  };
  butler: {
    ready: boolean;
    pending: boolean;
    isStreaming: boolean;
    sessionId: string | null;
    model: string | null;
    auth: {
      mode: "chatgpt" | "api" | "none" | "unknown";
      loggedIn: boolean;
    };
    messages: Array<{
      id: string;
      role: string;
      text: string;
      at: number | null;
    }>;
    contextUsage: {
      tokens: number | null;
      contextWindow: number | null;
      percent: number | null;
    };
    compaction: {
      autoEnabled: boolean;
      active: boolean;
      count: number;
      lastReason: "manual" | "threshold" | "overflow" | null;
      lastStartedAt: number | null;
      lastCompletedAt: number | null;
      lastTokensBefore: number | null;
      lastWillRetry: boolean;
      lastAborted: boolean;
      lastError: string | null;
    };
    lastError: string | null;
    compose: {
      provider: string | null;
      model: string | null;
      thinkingLevel: ButlerThinkingLevel;
      availableThinkingLevels: ButlerThinkingLevel[];
      availableModels: ModelOption[];
    };
  };
};

function formatTime(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatJumpLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown time";
  }

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatTimelineDayLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown";
  }

  return new Date(value).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function getTimelineDayKey(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }

  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupTimelineItems<T extends { id: string; text: string; at: number | null }>(items: T[]) {
  const groups: Array<{ key: string; label: string; firstId: string; items: T[] }> = [];

  for (const item of items) {
    const key = getTimelineDayKey(item.at);
    const current = groups.at(-1);

    if (!current || current.key !== key) {
      groups.push({
        key,
        label: formatTimelineDayLabel(item.at),
        firstId: item.id,
        items: [item]
      });
      continue;
    }

    current.items.push(item);
  }

  return groups;
}

function formatCompactCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "?";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`;
  }

  return `${value}`;
}

function formatContextUsage(contextUsage: Snapshot["butler"]["contextUsage"]): string {
  const { tokens, contextWindow, percent } = contextUsage;

  if (!contextWindow) {
    return "Unavailable";
  }

  if (tokens === null || percent === null) {
    return `? / ${formatCompactCount(contextWindow)}`;
  }

  return `${Math.round(percent)}% · ${formatCompactCount(tokens)} / ${formatCompactCount(contextWindow)}`;
}

function formatCompactionState(compaction: Snapshot["butler"]["compaction"]): string {
  if (!compaction.autoEnabled) {
    return "Off";
  }

  if (compaction.active) {
    return "Running";
  }

  if (compaction.lastError) {
    return "Failed";
  }

  if (!compaction.lastCompletedAt) {
    return "Auto";
  }

  return `${formatTime(compaction.lastCompletedAt)}${compaction.lastReason ? ` · ${compaction.lastReason}` : ""}`;
}

function formatCodexCompactionState(compaction: {
  active: boolean;
  count: number;
  lastCompletedAt: number | null;
}): string {
  if (compaction.active) {
    return "Running";
  }

  if (!compaction.lastCompletedAt) {
    return compaction.count > 0 ? `${compaction.count}x` : "Auto";
  }

  return `${formatTime(compaction.lastCompletedAt)} · ${compaction.count}x`;
}

function describeStatus(status: ThreadStatus): string {
  if (status === "active") {
    return "Running";
  }

  if (status === "idle") {
    return "Idle";
  }

  return "Unknown";
}

function itemTone(type: string): "user" | "assistant" | "system" {
  if (type === "userMessage") {
    return "user";
  }

  if (type === "agentMessage") {
    return "assistant";
  }

  return "system";
}

function itemLabel(type: string): string {
  switch (type) {
    case "userMessage":
      return "You";
    case "agentMessage":
      return "Codex";
    case "commandExecution":
      return "Shell";
    case "mcpToolCall":
      return "Tool";
    case "reasoning":
      return "Reasoning";
    default:
      return type;
  }
}

function shouldRenderItem(item: { type: string; text: string }): boolean {
  const text = item.text.trim();
  if (text) {
    return true;
  }

  return item.type === "commandExecution";
}

function StatusIcon({ kind }: { kind: "codex" | "auth" | "model" | "context" | "compaction" }) {
  if (kind === "codex") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 4.5h10M3 8h10M3 11.5h10M5 3v10M11 3v10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="square"
        />
      </svg>
    );
  }

  if (kind === "auth") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 2.5l4 1.6v3.7c0 2.3-1.5 4.4-4 5.7-2.5-1.3-4-3.4-4-5.7V4.1L8 2.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  if (kind === "model") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 6h4M6 8h4M6 10h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
      </svg>
    );
  }

  if (kind === "compaction") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 6.5A4 4 0 0 1 11 4l1 1M12 9.5A4 4 0 0 1 5 12l-1-1M10 5h2v2M4 9V7h2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="square" />
    </svg>
  );
}

function StatusItem({
  kind,
  tone,
  label,
  value
}: {
  kind: "codex" | "auth" | "model" | "context" | "compaction";
  tone: "accent" | "success" | "neutral";
  label: string;
  value: string;
}) {
  return (
    <div className={`status-item is-${tone}`}>
      <span className="status-item-icon">
        <StatusIcon kind={kind} />
      </span>
      <span className="status-item-copy">
        <span className="status-item-label">{label}</span>
        <span className="status-item-value">{value}</span>
      </span>
    </div>
  );
}

function extractCodeLanguage(children: ReactNode): string {
  const firstChild = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(firstChild)) {
    return "";
  }

  const className = typeof firstChild.props.className === "string" ? firstChild.props.className : "";
  const match = className.match(/language-([a-z0-9#+-]+)/i);
  return match?.[1] ?? "";
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          const language = extractCodeLanguage(children);
          return (
            <div className="code-block-shell">
              <div className="code-block-bar">
                <span>{language || "text"}</span>
              </div>
              <pre className="code-block-pre">{children}</pre>
            </div>
          );
        },
        code({ children, className, ...props }: ComponentPropsWithoutRef<"code">) {
          const isBlock = typeof className === "string" && className.includes("language-");
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }

          return (
            <code className="inline-code" {...props}>
              {children}
            </code>
          );
        }
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ThemeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5v2.1M8 11.4v2.1M3.8 4.1l1.5 1.5M10.7 10.4l1.5 1.5M2.5 8h2.1M11.4 8h2.1M3.8 11.9l1.5-1.5M10.7 5.6l1.5-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 7.3 13.2 2.8l-3.9 10.4-2.1-3.1-3.2-1.2 9.2-4.5-9.7 2.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(typeof payload.error === "string" ? payload.error : "Request failed");
  }
}

function readStoredValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(key) ?? "";
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (value) {
    window.localStorage.setItem(key, value);
    return;
  }

  window.localStorage.removeItem(key);
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") {
      return "system";
    }

    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [butlerDraft, setButlerDraft] = useState(() => readStoredValue(BUTLER_DRAFT_STORAGE_KEY));
  const [pendingButlerText, setPendingButlerText] = useState<string | null>(null);
  const [threadDraft, setThreadDraft] = useState("");
  const [threadsDrawerOpen, setThreadsDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeJumpId, setActiveJumpId] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const jumpFlashTimerRef = useRef<number | null>(null);
  const runScrollRef = useRef<HTMLDivElement | null>(null);
  const butlerScrollRef = useRef<HTMLDivElement | null>(null);
  const runPromptRefs = useRef<Record<string, HTMLElement | null>>({});
  const butlerPromptRefs = useRef<Record<string, HTMLElement | null>>({});
  const butlerMessageTimesRef = useRef<Record<string, number>>({});
  const [followRun, setFollowRun] = useState(true);
  const [followButler, setFollowButler] = useState(true);
  const [showPromptRail, setShowPromptRail] = useState(false);

  function clearLiveError() {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError((current) => (current === "Live updates disconnected. Refresh the page if this persists." ? null : current));
  }

  useEffect(() => {
    const root = document.documentElement;

    if (themePreference === "system") {
      root.removeAttribute("data-theme");
      window.localStorage.removeItem(THEME_STORAGE_KEY);
      return;
    }

    root.setAttribute("data-theme", themePreference);
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  }, [themePreference]);

  useEffect(() => {
    let closed = false;

    fetch("/api/bootstrap")
      .then((response) => response.json())
      .then((data) => {
        if (!closed) {
          setSnapshot(data);
        }
      })
      .catch((fetchError: Error) => {
        if (!closed) {
          setError(fetchError.message);
        }
      });

    const events = new EventSource("/api/events");
    events.onopen = () => {
      clearLiveError();
    };
    events.onmessage = (event) => {
      clearLiveError();
      setSnapshot(JSON.parse(event.data));
    };
    events.addEventListener("heartbeat", () => {
      clearLiveError();
    });
    events.onerror = () => {
      if (closed || errorTimerRef.current !== null) {
        return;
      }

      errorTimerRef.current = window.setTimeout(() => {
        errorTimerRef.current = null;
        if (!closed) {
          setError("Live updates disconnected. Refresh the page if this persists.");
        }
      }, 2500);
    };

    return () => {
      closed = true;
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
      if (jumpFlashTimerRef.current !== null) {
        window.clearTimeout(jumpFlashTimerRef.current);
        jumpFlashTimerRef.current = null;
      }
      events.close();
    };
  }, []);

  const activeThread = useMemo(() => {
    if (!snapshot?.codex.focusedWindowId) {
      return null;
    }

    return snapshot.codex.openThreads[snapshot.codex.focusedWindowId] ?? null;
  }, [snapshot]);

  useEffect(() => {
    const threadId = snapshot?.codex.focusedWindowId;
    setThreadDraft(threadId ? readStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${threadId}`) : "");
    setFollowRun(true);
  }, [snapshot?.codex.focusedWindowId]);

  useEffect(() => {
    writeStoredValue(BUTLER_DRAFT_STORAGE_KEY, butlerDraft);
  }, [butlerDraft]);

  useEffect(() => {
    const threadId = snapshot?.codex.focusedWindowId;
    if (!threadId) {
      return;
    }

    writeStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${threadId}`, threadDraft);
  }, [snapshot?.codex.focusedWindowId, threadDraft]);

  useEffect(() => {
    if (!threadsDrawerOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setThreadsDrawerOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [threadsDrawerOpen]);

  useEffect(() => {
    if (!activeThread || !followRun || !runScrollRef.current) {
      return;
    }

    const element = runScrollRef.current;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [activeThread, followRun]);

  useEffect(() => {
    if (!followButler || !butlerScrollRef.current) {
      return;
    }

    const element = butlerScrollRef.current;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [snapshot?.butler.messages, followButler]);

  useEffect(() => {
    if (!pendingButlerText || !snapshot) {
      return;
    }

    const hasCommittedPrompt = snapshot.butler.messages.some((message) => message.role.startsWith("user") && message.text === pendingButlerText);
    if (hasCommittedPrompt || (!snapshot.butler.pending && !snapshot.butler.isStreaming)) {
      setPendingButlerText(null);
    }
  }, [pendingButlerText, snapshot]);

  if (!snapshot) {
    return <div className="shell loading">Loading Butler…</div>;
  }

  const activeRunItems = activeThread
    ? activeThread.turns
        .flatMap((turn) => turn.items.filter(shouldRenderItem).map((item) => ({ ...item, turnId: turn.id, turnStartedAt: turn.startedAt })))
        .sort((a, b) => a.at - b.at)
    : [];

  const runPromptJumpList = activeRunItems.filter((item) => item.type === "userMessage");
  const butlerPromptJumpList = snapshot.butler.messages
    .map((message, index) => {
      const knownAt = message.at ?? butlerMessageTimesRef.current[message.id];
      if (typeof knownAt === "number" && Number.isFinite(knownAt)) {
        butlerMessageTimesRef.current[message.id] = knownAt;
        return { ...message, at: knownAt };
      }

      const fallbackAt = Date.now() - (snapshot.butler.messages.length - index) * 1000;
      butlerMessageTimesRef.current[message.id] = fallbackAt;
      return { ...message, at: fallbackAt };
    })
    .filter((message) => message.role.startsWith("user"));
  const runTimelineGroups = groupTimelineItems(runPromptJumpList);
  const butlerTimelineGroups = groupTimelineItems(butlerPromptJumpList);

  async function sendButlerMessage() {
    const text = butlerDraft.trim();
    if (!text) {
      return;
    }

    setError(null);
    setButlerDraft("");
    writeStoredValue(BUTLER_DRAFT_STORAGE_KEY, "");
    setFollowButler(true);
    setPendingButlerText(text);

    try {
      await postJson("/api/chat/messages", { text });
    } catch (sendError) {
      setPendingButlerText(null);
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    }
  }

  async function sendThreadMessage() {
    if (!activeThread) {
      return;
    }

    const text = threadDraft.trim();
    if (!text) {
      return;
    }

    setError(null);
    setThreadDraft("");
    writeStoredValue(`${THREAD_DRAFT_STORAGE_KEY_PREFIX}${activeThread.id}`, "");
    setFollowRun(true);

    try {
      await postJson("/api/threads/messages", { threadId: activeThread.id, text });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    }
  }

  async function updateButlerCompose(modelKey: string, thinkingLevel: ButlerThinkingLevel = snapshot.butler.compose.thinkingLevel) {
    if (!modelKey) {
      return;
    }

    try {
      await postJson("/api/chat/settings", { model: modelKey, thinkingLevel });
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    }
  }

  async function updateCodexCompose(model: string, effort: ReasoningEffort | null) {
    try {
      await postJson("/api/threads/settings", { model, effort });
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    }
  }

  async function deleteThread(threadId: string) {
    if (!window.confirm("Delete this Codex thread permanently?")) {
      return;
    }

    try {
      await postJson("/api/threads/delete", { threadId });
      setThreadsDrawerOpen(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function deleteAllThreads() {
    if (!window.confirm("Delete all Codex threads permanently?")) {
      return;
    }

    try {
      await postJson("/api/threads/delete-all", {});
      setThreadsDrawerOpen(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) {
      return;
    }

    event.preventDefault();
    submit();
  }

  function jumpToPrompt(
    container: HTMLDivElement | null,
    refs: Record<string, HTMLElement | null>,
    itemId: string,
    setFollow: (value: boolean) => void
  ) {
    const target = refs[itemId];
    if (!container || !target) {
      return;
    }

    setFollow(false);

    let offsetTop = 0;
    let current: HTMLElement | null = target;

    while (current && current !== container) {
      offsetTop += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }

    const centeredTop = Math.max(0, offsetTop - container.clientHeight / 2 + target.offsetHeight / 2);
    requestAnimationFrame(() => {
      container.scrollTop = centeredTop;
      requestAnimationFrame(() => {
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
      });
    });
  }

  const activeTabId = snapshot.codex.focusedWindowId ?? "butler";
  const butlerModelKey = snapshot.butler.compose.model ?? "";
  const codexEffortOptions =
    snapshot.codex.compose.availableModels.find((model) => model.id === snapshot.codex.compose.model)?.supportedReasoningEfforts ?? [];
  const butlerStatus = (() => {
    if (snapshot.butler.lastError) {
      return { tone: "error", text: snapshot.butler.lastError } as const;
    }

    if (snapshot.butler.compaction.active) {
      return { tone: "working", text: "Compacting context" } as const;
    }

    if (snapshot.butler.isStreaming) {
      return { tone: "working", text: "Working on request" } as const;
    }

    if (snapshot.butler.pending) {
      return { tone: "pending", text: "Starting request" } as const;
    }

    return { tone: "ready", text: "Ready" } as const;
  })();
  const showPendingButlerEntry =
    pendingButlerText &&
    !snapshot.butler.messages.some((message) => message.role.startsWith("user") && message.text === pendingButlerText);
  const topbarContextValue = activeThread ? formatContextUsage(activeThread.contextUsage) : formatContextUsage(snapshot.butler.contextUsage);
  const topbarCompactionValue = activeThread ? formatCodexCompactionState(activeThread.compaction) : formatCompactionState(snapshot.butler.compaction);
  const topbarCompactionTone = activeThread
    ? activeThread.compaction.active ? "accent" : "neutral"
    : snapshot.butler.compaction.active ? "accent" : "neutral";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src={manorLogoUrl} alt="Manor" className="brand-logo brand-logo-light" />
          <img src={manorLogoDarkUrl} alt="Manor" className="brand-logo brand-logo-dark" />
        </div>
        <div className="statusline">
          <label className="theme-control">
            <span className="theme-control-icon">
              <ThemeIcon />
            </span>
            <select value={themePreference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)} aria-label="Theme">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <StatusItem
            kind="codex"
            tone={snapshot.codex.connected ? "accent" : "neutral"}
            label="Codex"
            value={snapshot.codex.connected ? "Connected" : "Offline"}
          />
          <StatusItem
            kind="auth"
            tone={snapshot.butler.auth.loggedIn ? "success" : "neutral"}
            label="Auth"
            value={snapshot.butler.auth.mode}
          />
          <StatusItem
            kind="context"
            tone="neutral"
            label="Context"
            value={topbarContextValue}
          />
          <StatusItem
            kind="compaction"
            tone={topbarCompactionTone}
            label="Compact"
            value={topbarCompactionValue}
          />
        </div>
      </header>

      <main className="workspace-shell">
        <section className="workspace">
          <div className="workspace-tabs-shell">
            <button
              className={`workspace-tab workspace-tab-fixed ${activeTabId === "butler" ? "is-active" : ""}`}
              onClick={() => {
                postJson("/api/workspace/focus", {}).catch((focusError) =>
                  setError(focusError instanceof Error ? focusError.message : String(focusError))
                );
              }}
            >
              Butler
            </button>
            <div className="workspace-tabs-scroll">
              {snapshot.codex.windows.map((window) => (
                <div key={window.threadId} className={`workspace-tab workspace-tab-window ${activeTabId === window.threadId ? "is-active" : ""}`}>
                  <button
                    className="workspace-tab-main"
                    onClick={() => postJson("/api/windows/focus", { threadId: window.threadId }).catch(() => undefined)}
                  >
                    <span className="workspace-tab-label">{window.title}</span>
                    <span className="workspace-tab-meta">
                      {snapshot.codex.openThreads[window.threadId]?.compaction.active
                        ? "Compacting"
                        : snapshot.codex.openThreads[window.threadId]?.contextUsage.percent !== null &&
                            snapshot.codex.openThreads[window.threadId]?.contextUsage.percent !== undefined
                          ? `${Math.round(snapshot.codex.openThreads[window.threadId]!.contextUsage.percent!)}%`
                          : ""}
                    </span>
                  </button>
                  <button
                    className="workspace-tab-close"
                    onClick={() => postJson("/api/windows/close", { threadId: window.threadId }).catch(() => undefined)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className={`workspace-mobile-timeline ${showPromptRail ? "is-open" : ""}`}
              onClick={() => setShowPromptRail((current) => !current)}
              aria-label={showPromptRail ? "Hide timeline" : "Show timeline"}
              aria-expanded={showPromptRail}
            >
              ≣
            </button>
            <button
              className={`workspace-plus ${threadsDrawerOpen ? "is-open" : ""}`}
              onClick={() => setThreadsDrawerOpen((current) => !current)}
              aria-label="Browse Codex threads"
              aria-expanded={threadsDrawerOpen}
            >
              +
            </button>
          </div>

          {activeThread ? (
            <div className="workspace-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">Active run</span>
                  <h2>{activeThread.preview || "Untitled run"}</h2>
                  <p>
                    {describeStatus(activeThread.status)} • {activeThread.source} • updated {formatTime(activeThread.updatedAt)}
                  </p>
                </div>
                <div className="panel-controls">
                  <button className="panel-action panel-action-danger" onClick={() => void deleteThread(activeThread.id)}>
                    Delete
                  </button>
                  <label>
                    <span>Model</span>
                    <select
                      value={snapshot.codex.compose.model ?? ""}
                      onChange={(event) => {
                        const nextModel = event.target.value;
                        const model = snapshot.codex.compose.availableModels.find((entry) => entry.id === nextModel);
                        void updateCodexCompose(nextModel, model?.defaultReasoningEffort ?? null);
                      }}
                    >
                      {snapshot.codex.compose.availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Reasoning</span>
                    <select
                      value={snapshot.codex.compose.effort ?? ""}
                      onChange={(event) =>
                        void updateCodexCompose(snapshot.codex.compose.model ?? "", (event.target.value || null) as ReasoningEffort | null)
                      }
                      disabled={!snapshot.codex.compose.model || codexEffortOptions.length === 0}
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
                  </label>
                </div>
              </div>

              <div className={`workspace-body ${showPromptRail ? "is-detail-open" : "is-detail-closed"}`}>
                <section className="conversation-pane conversation-pane-full">
                  <div
                    ref={runScrollRef}
                    className="conversation-scroll"
                    onScroll={(event) => {
                      const element = event.currentTarget;
                      const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
                      setFollowRun(isNearBottom);
                    }}
                  >
                    {activeRunItems.length === 0 ? (
                      <div className="empty">This run is open, but its turn history has not loaded yet.</div>
                    ) : (
                      activeRunItems.map((item) => (
                        <article
                          key={item.id}
                          ref={(node) => {
                            runPromptRefs.current[item.id] = node;
                          }}
                          className={`entry is-${itemTone(item.type)}${activeJumpId === item.id ? " is-jump-target" : ""}`}
                        >
                          <div className="entry-head">
                            <span>{itemLabel(item.type)}</span>
                            <span>{formatJumpLabel(item.at)}</span>
                          </div>
                          <div className="entry-text">
                            <MarkdownMessage text={item.text || "Running shell command"} />
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                  <div className="composer">
                    <div className="composer-main">
                      <textarea
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
                      <button className="composer-send composer-send-mobile" onClick={() => void sendThreadMessage()} disabled={!threadDraft.trim()} aria-label="Send message">
                        <span className="composer-send-label">Send</span>
                        <span className="composer-send-icon">
                          <SendIcon />
                        </span>
                      </button>
                    </div>
                    <div className="composer-footer">
                      <div className="composer-note">Cmd/Ctrl + Enter sends</div>
                      <button className="composer-send composer-send-desktop" onClick={() => void sendThreadMessage()} disabled={!threadDraft.trim()} aria-label="Send message">
                        <span className="composer-send-label">Send</span>
                        <span className="composer-send-icon">
                          <SendIcon />
                        </span>
                      </button>
                    </div>
                  </div>
                </section>
                <aside className={`detail-pane ${showPromptRail ? "is-open" : "is-closed"}`}>
                  {showPromptRail ? (
                    <section className="detail-block">
                      <div className="detail-header">
                        <span className="eyebrow">Timeline</span>
                        <div className="detail-actions">
                          {runTimelineGroups.length > 1 ? (
                            <select
                              className="detail-select"
                              aria-label="Jump to date"
                              defaultValue=""
                              onChange={(event) => {
                                const itemId = event.target.value;
                                if (!itemId) {
                                  return;
                                }
                                jumpToPrompt(runScrollRef.current, runPromptRefs.current, itemId, setFollowRun);
                                event.target.value = "";
                              }}
                            >
                              <option value="">Jump to date</option>
                              {runTimelineGroups.map((group) => (
                                <option key={group.key} value={group.firstId}>
                                  {group.label}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          <button className="detail-dismiss" onClick={() => setShowPromptRail(false)} aria-label="Hide timeline">
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="detail-list-scroll">
                        {runTimelineGroups.length === 0 ? (
                          <div className="empty">No prompts yet.</div>
                        ) : (
                          runTimelineGroups.map((group) => (
                            <section key={group.key} className="detail-group">
                              <div className="detail-group-label">{group.label}</div>
                              <div className="detail-group-items">
                                {group.items.map((item, index) => (
                                  <button
                                    key={item.id}
                                    className="detail-link"
                                    onClick={() => jumpToPrompt(runScrollRef.current, runPromptRefs.current, item.id, setFollowRun)}
                                  >
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
                    <button className="detail-open" onClick={() => setShowPromptRail(true)} aria-label="Show timeline">
                      Timeline
                    </button>
                  )}
                </aside>
              </div>
            </div>
          ) : (
            <div className="workspace-panel">
              <div className={`workspace-body ${showPromptRail ? "is-detail-open" : "is-detail-closed"}`}>
              <section className="conversation-pane conversation-pane-full">
                <div
                  ref={butlerScrollRef}
                  className="conversation-scroll"
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
                    setFollowButler(isNearBottom);
                  }}
                >
                  {snapshot.butler.messages.length === 0 ? (
                    <div className="empty">Ask Butler about run status, next steps, or which run you should open.</div>
                  ) : (
                    snapshot.butler.messages.map((message) => (
                      <article
                        key={message.id}
                        ref={(node) => {
                          if (message.role.startsWith("user")) {
                            butlerPromptRefs.current[message.id] = node;
                          }
                        }}
                        className={`entry is-${message.role.startsWith("assistant") ? "assistant" : "user"}${activeJumpId === message.id ? " is-jump-target" : ""}`}
                      >
                        <div className="entry-head">
                          <span>{message.role.startsWith("assistant") ? "Butler" : "You"}</span>
                        </div>
                        <div className="entry-text">
                          <MarkdownMessage text={message.text || "…"} />
                        </div>
                        </article>
                      ))
                  )}
                  {showPendingButlerEntry ? (
                    <article className="entry is-user is-pending">
                      <div className="entry-head">
                        <span>You</span>
                        <span>sending</span>
                      </div>
                      <div className="entry-text">
                        <MarkdownMessage text={pendingButlerText} />
                      </div>
                    </article>
                  ) : null}
                  {snapshot.butler.pending || snapshot.butler.isStreaming ? (
                    <div
                      className={`working-indicator ${snapshot.butler.isStreaming ? "is-streaming" : "is-pending"}`}
                      aria-live="polite"
                    >
                      <span className="working-indicator-label">Butler</span>
                      <span className="working-indicator-text">{butlerStatus.text}</span>
                    </div>
                  ) : null}
                </div>
                <div className="composer">
                  <div className="composer-main">
                    <textarea
                      name="butler-chat-message"
                      value={butlerDraft}
                      onChange={(event) => setButlerDraft(event.target.value)}
                      onKeyDown={(event) => handleComposerKeyDown(event, () => void sendButlerMessage())}
                      placeholder="Ask Butler about any run"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={true}
                      rows={3}
                    />
                    <button className="composer-send composer-send-mobile" onClick={() => void sendButlerMessage()} disabled={!butlerDraft.trim()} aria-label="Send message">
                      <span className="composer-send-label">Send</span>
                      <span className="composer-send-icon">
                        <SendIcon />
                      </span>
                    </button>
                  </div>
                  <div className="composer-footer">
                    <div className="composer-inline-controls">
                      <select
                        value={butlerModelKey}
                        onChange={(event) => void updateButlerCompose(event.target.value)}
                        aria-label="Butler model"
                      >
                        {snapshot.butler.compose.availableModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={snapshot.butler.compose.thinkingLevel}
                        onChange={(event) => void updateButlerCompose(butlerModelKey, event.target.value as ButlerThinkingLevel)}
                        aria-label="Butler reasoning"
                      >
                        {snapshot.butler.compose.availableThinkingLevels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                      ))}
                    </select>
                  </div>
                    <div className="composer-note">Cmd/Ctrl + Enter sends</div>
                    <button className="composer-send composer-send-desktop" onClick={() => void sendButlerMessage()} disabled={!butlerDraft.trim()} aria-label="Send message">
                      <span className="composer-send-label">Send</span>
                      <span className="composer-send-icon">
                        <SendIcon />
                      </span>
                    </button>
                  </div>
                </div>
              </section>
                <aside className={`detail-pane ${showPromptRail ? "is-open" : "is-closed"}`}>
                  {showPromptRail ? (
                    <section className="detail-block">
                      <div className="detail-header">
                        <span className="eyebrow">Timeline</span>
                        <div className="detail-actions">
                          {butlerTimelineGroups.length > 1 ? (
                            <select
                              className="detail-select"
                              aria-label="Jump to date"
                              defaultValue=""
                              onChange={(event) => {
                                const itemId = event.target.value;
                                if (!itemId) {
                                  return;
                                }
                                jumpToPrompt(butlerScrollRef.current, butlerPromptRefs.current, itemId, setFollowButler);
                                event.target.value = "";
                              }}
                            >
                              <option value="">Jump to date</option>
                              {butlerTimelineGroups.map((group) => (
                                <option key={group.key} value={group.firstId}>
                                  {group.label}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          <button className="detail-dismiss" onClick={() => setShowPromptRail(false)} aria-label="Hide timeline">
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="detail-list-scroll">
                        {butlerTimelineGroups.length === 0 ? (
                          <div className="empty">No prompts yet.</div>
                        ) : (
                          butlerTimelineGroups.map((group) => (
                            <section key={group.key} className="detail-group">
                              <div className="detail-group-label">{group.label}</div>
                              <div className="detail-group-items">
                                {group.items.map((message, index) => (
                                  <button
                                    key={message.id}
                                    className="detail-link"
                                    onClick={() => jumpToPrompt(butlerScrollRef.current, butlerPromptRefs.current, message.id, setFollowButler)}
                                  >
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
                    <button className="detail-open" onClick={() => setShowPromptRail(true)} aria-label="Show timeline">
                      Timeline
                    </button>
                  )}
                </aside>
              </div>
            </div>
          )}
        </section>
      </main>

      <div
        className={`threads-backdrop ${threadsDrawerOpen ? "is-open" : ""}`}
        onClick={() => setThreadsDrawerOpen(false)}
        aria-hidden={threadsDrawerOpen ? "false" : "true"}
      />
      <aside className={`threads-drawer ${threadsDrawerOpen ? "is-open" : ""}`}>
        <div className="threads-drawer-head">
          <div>
            <span className="eyebrow">Threads</span>
            <h2>Codex threads</h2>
          </div>
          <div className="threads-drawer-actions">
            <button className="threads-drawer-delete" onClick={() => void deleteAllThreads()} disabled={snapshot.codex.threads.length === 0}>
              Delete all
            </button>
            <button className="threads-drawer-close" onClick={() => setThreadsDrawerOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div className="threads-drawer-body">
          {snapshot.codex.threads.length === 0 ? (
            <div className="empty">No Codex threads are available yet.</div>
          ) : (
            snapshot.codex.threads.map((thread) => (
              <div
                key={thread.id}
                className={`thread-row ${snapshot.codex.focusedWindowId === thread.id ? "is-active" : ""}`}
              >
                <button
                  className="thread-row-main"
                  onClick={() => {
                    setThreadsDrawerOpen(false);
                    postJson("/api/windows/open", { threadId: thread.id }).catch((openError) =>
                      setError(openError instanceof Error ? openError.message : String(openError))
                    );
                  }}
                >
                  <div className="thread-row-top">
                    <span className={`job-status is-${thread.status}`}>{describeStatus(thread.status)}</span>
                    <span className="job-time">{formatTime(thread.updatedAt)}</span>
                  </div>
                  <strong>{thread.preview || "Untitled run"}</strong>
                  <span>{thread.source}</span>
                </button>
                <button className="thread-row-delete" onClick={() => void deleteThread(thread.id)}>
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {(error || snapshot.codex.lastError || snapshot.butler.lastError) && (
        <footer className="statusbar is-error">{error || snapshot.codex.lastError || snapshot.butler.lastError}</footer>
      )}
    </div>
  );
}
