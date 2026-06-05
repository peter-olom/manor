import { useEffect, useMemo, useRef, useState } from "react";

import manorLogoUrl from "./assets/manor-logo.svg";
import manorLogoDarkUrl from "./assets/manor-logo-dark.svg";
import { postJson } from "./api";
import { ButlerSurface } from "./ButlerSurface";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { ButlerTabIcon, CloseIcon, CopyIcon, ScratchPadTabIcon, SetupTabIcon, TerminalTabIcon, ThemeIcon, ThreadsIcon, TrashIcon } from "./icons";
import {
  mergeKnownImages,
  useShellSnapshot,
  useServerToastEvent,
  useTransportState
} from "./live-state";
import { StatusItem } from "./StatusItem";
import { ScratchPadPanel } from "./ScratchPadPanel";
import { ThreadSurface } from "./ThreadSurface";
import type {
  AppToast,
  ButlerThreadCallback,
  CodexThreadSummary,
  ComposerPrefill,
  ComposerPrefillTarget,
  ConfirmDialogState,
  FileReference,
  PreviewMedia,
  SetupCommandMode,
  TerminalTarget,
  ThemePreference,
  WorkspaceSurface
} from "./types";
import {
  THEME_STORAGE_KEY,
  buildWorkspaceQuery,
  describeCallbackState,
  describeStatus,
  formatAuthStatus,
  formatCodexCompactionState,
  formatContextUsage,
  formatCompactionState,
  formatJobIdLabel,
  formatThreadTitle,
  onboardingStatusLabel,
  readStoredValue,
  readWorkspaceQuery,
  resolveThemePreference
} from "./utils";

function isClosedPlaceholderThread(thread: CodexThreadSummary, callback: ButlerThreadCallback | null | undefined): boolean {
  return (
    thread.status === "unknown" &&
    callback?.callbackState === "closed" &&
    !thread.executionContract &&
    !thread.supervisionChecklist &&
    thread.supervisor.summary === "No supervisor summary yet." &&
    !thread.supervisor.latestUserPrompt &&
    !thread.supervisor.latestAgentReply
  );
}

function getThreadProjectPath(thread: CodexThreadSummary | undefined): string | null {
  return thread?.cwd ?? thread?.executionContract?.workspaceCwd ?? null;
}

function syncTerminalFrameTheme(frame: HTMLIFrameElement | null, lightTheme: boolean) {
  const doc = frame?.contentDocument;
  if (!doc) {
    return;
  }

  const styleId = "manor-terminal-theme";
  const existing = doc.getElementById(styleId);
  if (!lightTheme) {
    doc.documentElement.style.background = "";
    doc.body.style.background = "";
    existing?.remove();
    return;
  }

  doc.documentElement.style.background = "#ffffff";
  doc.body.style.background = "#ffffff";

  const style = existing ?? doc.createElement("style");
  style.id = styleId;
  style.textContent = `
    html, body, #terminal-container, #terminal-container .terminal, .xterm, .xterm .xterm-viewport, .xterm .xterm-screen {
      background: #ffffff !important;
    }

    .xterm .xterm-screen canvas {
      filter: invert(1) hue-rotate(180deg) brightness(1.22) contrast(1.08) !important;
    }

    .xterm .composition-view {
      background: #ffffff !important;
      color: #10233f !important;
    }
  `;

  if (!existing) {
    doc.head.appendChild(style);
  }
}

export function App() {
  const initialWorkspaceQuery = readWorkspaceQuery();
  const shell = useShellSnapshot();
  const serverToast = useServerToastEvent();
  const transport = useTransportState();
  const [selectedSurface, setSelectedSurface] = useState<WorkspaceSurface | null>(initialWorkspaceQuery.surface);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialWorkspaceQuery.threadId);
  const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>(initialWorkspaceQuery.terminalTarget);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") {
      return "system";
    }
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [setupCommandTarget, setSetupCommandTarget] = useState<SetupCommandMode>("builtInTerminal");
  const [threadsDrawerOpen, setThreadsDrawerOpen] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<PreviewMedia | null>(null);
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefill | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [copiedCommandKey, setCopiedCommandKey] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const copiedCommandTimerRef = useRef<number | null>(null);
  const lastFocusedWindowIdRef = useRef<string | null>(null);
  const hasSeenFocusedWindowRef = useRef(false);
  const hasShownDisconnectToastRef = useRef(false);
  const pendingWindowSyncRef = useRef<string | null>(null);
  const closingWindowThreadIdRef = useRef<string | null>(null);
  const codexTerminalFrameRef = useRef<HTMLIFrameElement | null>(null);
  const butlerTerminalFrameRef = useRef<HTMLIFrameElement | null>(null);
  const activeThreadId =
    selectedSurface === "thread"
      ? selectedThreadId ?? shell?.codex.focusedWindowId ?? null
      : null;
  const composerPrefillTarget: ComposerPrefillTarget | null =
    selectedSurface === "thread" && activeThreadId
      ? { kind: "thread", threadId: activeThreadId }
      : selectedSurface === "butler"
        ? { kind: "butler" }
        : null;
  const composerPrefillTargetLabel =
    composerPrefillTarget?.kind === "thread" ? "this thread" : composerPrefillTarget?.kind === "butler" ? "Butler" : null;
  const threadSummaryById = useMemo(
    () => new Map((shell?.codex.threads ?? []).map((thread) => [thread.id, thread])),
    [shell?.codex.threads]
  );
  const callbackByThreadId = useMemo(
    () => new Map((shell?.butler.supervision.callbacks ?? []).map((callback) => [callback.threadId, callback])),
    [shell?.butler.supervision.callbacks]
  );
  const visibleCodexThreads = useMemo(
    () =>
      (shell?.codex.threads ?? []).filter(
        (thread) => !isClosedPlaceholderThread(thread, callbackByThreadId.get(thread.id))
      ),
    [callbackByThreadId, shell?.codex.threads]
  );
  const activeThreadSummary = activeThreadId ? threadSummaryById.get(activeThreadId) ?? null : null;

  function showToast(message: string, tone: "success" | "error" | "info" = "success", duration = 2600, key?: string) {
    const nextKey = key ?? `${tone}:${message}`;
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ key: nextKey, message, tone });
    if (duration > 0) {
      toastTimerRef.current = window.setTimeout(() => {
        setToast((current) => (current?.key === nextKey ? null : current));
        toastTimerRef.current = null;
      }, duration);
    }
  }

  function showErrorToast(error: unknown, key?: string, duration = 3600) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, "error", duration, key);
  }

  function createClientId(): string {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `composer-prefill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function writeClipboardText(value: string): Promise<void> {
    const clipboard = navigator.clipboard;
    let clipboardError: unknown = null;

    if (clipboard && typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(value);
        return;
      } catch (error) {
        clipboardError = error;
      }
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.width = "1px";
    textarea.style.height = "1px";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      if (!document.execCommand("copy")) {
        throw new Error("Copy is unavailable in this browser context.");
      }
    } catch (error) {
      throw clipboardError ?? error;
    } finally {
      textarea.remove();
      previousActiveElement?.focus();
    }
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await writeClipboardText(value);
      showToast(successMessage, "success", 1200);
    } catch (error) {
      showErrorToast(error);
    }
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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    function handlePopState() {
      const query = readWorkspaceQuery();
      setSelectedSurface(query.surface);
      setSelectedThreadId(query.threadId);
      setTerminalTarget(query.terminalTarget);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!shell || selectedSurface !== null) {
      return;
    }

    setSelectedSurface(shell.butler.onboarding.complete ? "butler" : "setup");
  }, [selectedSurface, shell]);

  useEffect(() => {
    if (shell?.butler.onboarding.complete && selectedSurface === "setup") {
      setSelectedSurface("butler");
    }
  }, [selectedSurface, shell?.butler.onboarding.complete]);

  useEffect(() => {
    const closingThreadId = closingWindowThreadIdRef.current;
    if (!closingThreadId || !shell) {
      return;
    }

    const stillOpen = shell.codex.windows.some((window) => window.threadId === closingThreadId);
    if (!stillOpen) {
      closingWindowThreadIdRef.current = null;
    }
  }, [shell]);

  useEffect(() => {
    if (!shell || selectedSurface !== "thread" || !selectedThreadId) {
      pendingWindowSyncRef.current = null;
      return;
    }

    if (shell.codex.windows.some((window) => window.threadId === selectedThreadId)) {
      pendingWindowSyncRef.current = null;
      return;
    }

    if (closingWindowThreadIdRef.current === selectedThreadId) {
      pendingWindowSyncRef.current = null;
      return;
    }

    if (shell.codex.threads.some((thread) => thread.id === selectedThreadId)) {
      const requestKey = `open:${selectedThreadId}`;
      if (pendingWindowSyncRef.current === requestKey) {
        return;
      }
      pendingWindowSyncRef.current = requestKey;
      postJson("/api/windows/open", { threadId: selectedThreadId }).catch((error) => {
        if (pendingWindowSyncRef.current === requestKey) {
          pendingWindowSyncRef.current = null;
        }
        showErrorToast(error);
      });
      return;
    }

    pendingWindowSyncRef.current = null;
    setSelectedThreadId(null);
    setSelectedSurface(shell.butler.onboarding.complete ? "butler" : "setup");
  }, [selectedSurface, selectedThreadId, shell]);

  useEffect(() => {
    if (selectedSurface !== "thread" || !shell) {
      return;
    }

    if (selectedThreadId) {
      const threadStillExists =
        shell.codex.windows.some((window) => window.threadId === selectedThreadId) ||
        shell.codex.threads.some((thread) => thread.id === selectedThreadId);

      if (threadStillExists) {
        return;
      }
    }

    if (shell.codex.focusedWindowId) {
      setSelectedThreadId(shell.codex.focusedWindowId);
      return;
    }

    if (selectedThreadId) {
      return;
    }

    setSelectedSurface(shell.butler.onboarding.complete ? "butler" : "setup");
  }, [selectedSurface, selectedThreadId, shell]);

  useEffect(() => {
    if (!shell) {
      return;
    }

    const focusedWindowId = shell.codex.focusedWindowId ?? null;
    const previousFocusedWindowId = lastFocusedWindowIdRef.current;
    lastFocusedWindowIdRef.current = focusedWindowId;

    if (!hasSeenFocusedWindowRef.current) {
      hasSeenFocusedWindowRef.current = true;
      return;
    }

    if (selectedSurface !== "butler") {
      return;
    }

    if (previousFocusedWindowId !== null || !focusedWindowId) {
      return;
    }

    if (!threadSummaryById.has(focusedWindowId)) {
      return;
    }

    setSelectedSurface("thread");
    setSelectedThreadId(focusedWindowId);
  }, [selectedSurface, shell, threadSummaryById]);

  useEffect(() => {
    if (!shell || typeof window === "undefined") {
      return;
    }

    const surface = selectedSurface ?? (shell.butler.onboarding.complete ? "butler" : "setup");
    const nextQuery = buildWorkspaceQuery({
      surface,
      threadId: surface === "thread" ? selectedThreadId ?? shell.codex.focusedWindowId ?? null : null,
      terminalTarget
    });

    if (window.location.search !== nextQuery) {
      window.history.replaceState(null, "", `${window.location.pathname}${nextQuery}`);
    }
  }, [selectedSurface, selectedThreadId, shell, terminalTarget]);

  useEffect(() => {
    if (transport.disconnected) {
      if (!hasShownDisconnectToastRef.current) {
        hasShownDisconnectToastRef.current = true;
        showToast("Live updates disconnected. Reconnecting automatically. Refresh only if this persists.", "error", 0, "live-disconnect");
      }
      return;
    }

    hasShownDisconnectToastRef.current = false;
    setToast((current) => (current?.key === "live-disconnect" ? null : current));
  }, [transport.disconnected]);

  useEffect(() => {
    if (!serverToast) {
      return;
    }

    showToast(serverToast.message, serverToast.tone, serverToast.duration, serverToast.id);
  }, [serverToast]);

  useEffect(() => {
    const isLightTheme = resolveThemePreference(themePreference, systemPrefersDark);
    syncTerminalFrameTheme(codexTerminalFrameRef.current, isLightTheme);
    syncTerminalFrameTheme(butlerTerminalFrameRef.current, isLightTheme);
  }, [systemPrefersDark, themePreference]);

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
    if (!confirmDialog) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !confirmBusy) {
        setConfirmDialog(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmBusy, confirmDialog]);

  function openThread(threadId: string) {
    if (closingWindowThreadIdRef.current === threadId) {
      closingWindowThreadIdRef.current = null;
    }
    setSelectedSurface("thread");
    setSelectedThreadId(threadId);
    const isOpen = shell?.codex.windows.some((window) => window.threadId === threadId);
    const requestKey = `${isOpen ? "focus" : "open"}:${threadId}`;
    pendingWindowSyncRef.current = requestKey;
    postJson(isOpen ? "/api/windows/focus" : "/api/windows/open", { threadId }).catch((error) => {
      if (pendingWindowSyncRef.current === requestKey) {
        pendingWindowSyncRef.current = null;
      }
      showErrorToast(error);
    });
  }

  async function closeThreadWindow(threadId: string) {
    closingWindowThreadIdRef.current = threadId;
    const remainingWindows = shell?.codex.windows.filter((window) => window.threadId !== threadId) ?? [];
    const isActiveWindow =
      (selectedSurface === "thread" && selectedThreadId === threadId);

    if (isActiveWindow) {
      const nextThreadId = remainingWindows[0]?.threadId ?? null;
      if (nextThreadId) {
        setSelectedSurface("thread");
        setSelectedThreadId(nextThreadId);
      } else {
        setSelectedThreadId(null);
        setSelectedSurface(shell?.butler.onboarding.complete ? "butler" : "setup");
      }
    }

    try {
      await postJson("/api/windows/close", { threadId });
    } catch (error) {
      if (closingWindowThreadIdRef.current === threadId) {
        closingWindowThreadIdRef.current = null;
      }
      showErrorToast(error);
    }
  }

  function confirmDeleteThread(threadId: string) {
    setConfirmDialog({
      title: "Delete thread?",
      message: "This Codex thread will be removed permanently.",
      confirmLabel: "Delete thread",
      tone: "danger",
      onConfirm: async () => {
        await postJson("/api/threads/delete", { threadId });
        setThreadsDrawerOpen(false);
        showToast("Thread deleted");
      }
    });
  }

  function confirmDeleteProof(proofId: string) {
    setConfirmDialog({
      title: "Delete proof?",
      message: "This proof run and its files will be removed permanently.",
      confirmLabel: "Delete proof",
      tone: "danger",
      onConfirm: async () => {
        await postJson("/api/proofs/delete", { proofId });
        showToast("Proof deleted");
      }
    });
  }

  function confirmDeleteAllThreads() {
    setConfirmDialog({
      title: "Delete all threads?",
      message: "All Codex threads will be removed permanently.",
      confirmLabel: "Delete all",
      tone: "danger",
      onConfirm: async () => {
        await postJson("/api/threads/delete-all", {});
        setThreadsDrawerOpen(false);
        showToast("All threads deleted");
      }
    });
  }

  async function handleConfirmAction() {
    if (!confirmDialog || confirmBusy) {
      return;
    }

    setConfirmBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } catch (error) {
      showErrorToast(error);
    } finally {
      setConfirmBusy(false);
    }
  }

  async function copySetupCommand(command: string, key: string) {
    try {
      await writeClipboardText(command);
      setCopiedCommandKey(key);
      showToast("Command copied", "success", 1200, "command-copied");
      if (copiedCommandTimerRef.current !== null) {
        window.clearTimeout(copiedCommandTimerRef.current);
      }
      copiedCommandTimerRef.current = window.setTimeout(() => {
        setCopiedCommandKey((current) => (current === key ? null : current));
        copiedCommandTimerRef.current = null;
      }, 1200);
    } catch (error) {
      showErrorToast(error);
    }
  }

  const showSetupGuide = !shell?.butler.onboarding.complete;
  const activeTabId =
    selectedSurface === "setup"
      ? "setup"
      : selectedSurface === "terminal"
        ? "terminal"
        : selectedSurface === "scratchPad"
          ? "scratchPad"
          : selectedSurface === "thread"
            ? selectedThreadId ?? shell?.codex.focusedWindowId ?? (showSetupGuide ? "setup" : "butler")
            : selectedSurface === "butler"
              ? "butler"
              : shell?.codex.focusedWindowId ?? (showSetupGuide ? "setup" : "butler");
  const activeScratchCount =
    (shell?.butler.scratchPad.counts.captured ?? 0) +
    (shell?.butler.scratchPad.counts.exploring ?? 0) +
    (shell?.butler.scratchPad.counts.ready_for_review ?? 0);
  const nextTerminalTarget =
    shell?.butler.onboarding.steps.find((step) => step.status === "pending")?.id === "butlerAuth" ? "butlerTerminal" : "codexTerminal";
  const terminalUrl = terminalTarget === "butlerTerminal" ? "/butler-terminal/" : "/terminal/";
  const isLightTheme = resolveThemePreference(themePreference, systemPrefersDark);
  const topbarContextValue = activeThreadSummary ? formatContextUsage(activeThreadSummary.contextUsage) : formatContextUsage(shell?.butler.contextUsage ?? { tokens: null, contextWindow: null, percent: null });
  const topbarCompactionValue = activeThreadSummary ? formatCodexCompactionState(activeThreadSummary.compaction) : formatCompactionState(shell?.butler.compaction ?? {
    active: false,
    count: 0,
    lastReason: null
  });
  const topbarCompactionTone = activeThreadSummary
    ? activeThreadSummary.compaction.active ? "accent" : "neutral"
    : shell?.butler.compaction.active ? "accent" : "neutral";

  function handleComposerPrefillConsumed(prefillId: string) {
    setComposerPrefill((current) => (current?.id === prefillId ? null : current));
  }

  function handleAnnotatedProofAttached(payload: { attachment: FileReference; text: string }) {
    if (!composerPrefillTarget) {
      showToast("Open Butler or a thread before attaching annotated proof.", "error", 3600);
      return;
    }

    if (payload.attachment.mimeType.startsWith("image/")) {
      mergeKnownImages([payload.attachment]);
    }

    setComposerPrefill({
      id: createClientId(),
      target: composerPrefillTarget,
      text: payload.text,
      attachment: payload.attachment
    });
    setPreviewMedia(null);
    showToast(
      composerPrefillTarget.kind === "thread"
        ? "Annotated proof added to the thread composer"
        : "Annotated proof added to Butler",
      "success",
      2200
    );
  }

  if (!shell) {
    return <div className="shell loading">Loading Butler…</div>;
  }

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
            tone={shell.codex.connected ? "accent" : "neutral"}
            label="Codex worker"
            value={shell.codex.connected ? "Online" : "Offline"}
          />
          <StatusItem
            kind="auth"
            tone={shell.codex.auth.loggedIn ? "success" : shell.codex.auth.mode === "none" ? "neutral" : "danger"}
            label="Codex auth"
            value={formatAuthStatus(shell.codex.auth)}
          />
          <StatusItem kind="context" tone="neutral" label="Context" value={topbarContextValue} />
          <StatusItem kind="compaction" tone={topbarCompactionTone} label="Compact" value={topbarCompactionValue} />
        </div>
      </header>

      <main className="workspace-shell">
        <section className="workspace">
          <div className="workspace-tabs-shell">
            {showSetupGuide ? (
              <button className={`workspace-tab workspace-tab-fixed workspace-tab-icon-button workspace-tab-setup ${activeTabId === "setup" ? "is-active" : ""}`} aria-label="Setup" title="Setup" onClick={() => {
                setSelectedSurface("setup");
                setSelectedThreadId(null);
              }}>
                <SetupTabIcon />
                <span className="workspace-tab-mobile-label">Setup</span>
              </button>
            ) : null}
            <button className={`workspace-tab workspace-tab-fixed workspace-tab-icon-button ${activeTabId === "butler" ? "is-active" : ""}`} aria-label="Butler" title="Butler" onClick={() => {
              setSelectedSurface("butler");
              setSelectedThreadId(null);
              postJson("/api/workspace/focus", {}).catch((error) => showErrorToast(error));
            }}>
              <ButlerTabIcon />
            </button>
            <button className={`workspace-tab workspace-tab-fixed workspace-tab-icon-button ${activeTabId === "scratchPad" ? "is-active" : ""}`} aria-label="Scratch pad" title="Scratch pad" onClick={() => {
              setSelectedSurface("scratchPad");
              setSelectedThreadId(null);
            }}>
              <ScratchPadTabIcon />
              {activeScratchCount > 0 ? <span className="workspace-tab-count">{activeScratchCount}</span> : null}
            </button>
            <button className={`workspace-tab workspace-tab-fixed workspace-tab-icon-button ${activeTabId === "terminal" ? "is-active" : ""}`} aria-label="Terminal" title="Terminal" onClick={() => {
              setSelectedSurface("terminal");
              setSelectedThreadId(null);
            }}>
              <TerminalTabIcon />
            </button>
            <div className="workspace-tabs-scroll">
              {shell.codex.windows.map((window) => {
                const threadSummary = threadSummaryById.get(window.threadId);
                const projectPath = getThreadProjectPath(threadSummary);
                return (
                  <div key={window.threadId} className={`workspace-tab workspace-tab-window ${activeTabId === window.threadId ? "is-active" : ""} ${threadSummary?.status === "active" ? "has-active-work" : ""}`}>
                    {threadSummary?.status === "active" ? <span className="workspace-tab-activity-dot" aria-hidden="true" /> : null}
                    <button className="workspace-tab-main" onClick={() => openThread(window.threadId)} title={projectPath ? `${window.title}\n${projectPath}` : window.title}>
                      <span className="workspace-tab-title-line">
                        <span className="workspace-tab-label">{window.title}</span>
                        <span className="workspace-tab-meta">
                          {threadSummary?.compaction.active
                            ? "Compacting"
                            : threadSummary?.contextUsage.percent !== null && threadSummary?.contextUsage.percent !== undefined
                              ? `${Math.round(threadSummary.contextUsage.percent)}%`
                              : ""}
                        </span>
                      </span>
                    </button>
                    <button className="workspace-tab-copy" onClick={() => void copyText(window.threadId, "Job ID copied")} aria-label="Copy job ID" title="Copy job ID">
                      <CopyIcon />
                    </button>
                    <button className="workspace-tab-close" onClick={() => void closeThreadWindow(window.threadId)}>
                      ×
                    </button>
                    {projectPath ? (
                      <button className="workspace-tab-path-button" onClick={() => openThread(window.threadId)} title={projectPath}>
                        <span className="workspace-tab-path">{projectPath}</span>
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button className={`workspace-plus ${threadsDrawerOpen ? "is-open" : ""}`} onClick={() => setThreadsDrawerOpen((current) => !current)} aria-label="Browse Codex threads" aria-expanded={threadsDrawerOpen}>
              <ThreadsIcon />
            </button>
          </div>

          <div className={`workspace-panel workspace-panel-terminal ${activeTabId === "terminal" ? "" : "is-hidden"}`} aria-hidden={activeTabId === "terminal" ? undefined : true}>
            <div className="terminal-toolbar">
              <div className="terminal-subtabs" role="tablist" aria-label="Terminal containers">
                <button className={`terminal-subtab ${terminalTarget === "codexTerminal" ? "is-active" : ""}`} onClick={() => setTerminalTarget("codexTerminal")} role="tab" aria-selected={terminalTarget === "codexTerminal"}>
                  Codex
                </button>
                <button className={`terminal-subtab ${terminalTarget === "butlerTerminal" ? "is-active" : ""}`} onClick={() => setTerminalTarget("butlerTerminal")} role="tab" aria-selected={terminalTarget === "butlerTerminal"}>
                  Butler
                </button>
              </div>
              <div className="terminal-toolbar-actions">
                <a className="panel-action panel-action-link" href={terminalUrl} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
              </div>
            </div>
            <div className={`terminal-shell ${isLightTheme ? "is-light-theme" : ""}`}>
              <iframe
                ref={codexTerminalFrameRef}
                className={`terminal-frame ${terminalTarget === "codexTerminal" ? "is-active" : ""} ${isLightTheme ? "is-light-theme" : ""}`}
                src="/terminal/"
                title="Codex terminal"
                onLoad={() => syncTerminalFrameTheme(codexTerminalFrameRef.current, isLightTheme)}
              />
              <iframe
                ref={butlerTerminalFrameRef}
                className={`terminal-frame ${terminalTarget === "butlerTerminal" ? "is-active" : ""} ${isLightTheme ? "is-light-theme" : ""}`}
                src="/butler-terminal/"
                title="Butler terminal"
                onLoad={() => syncTerminalFrameTheme(butlerTerminalFrameRef.current, isLightTheme)}
              />
            </div>
          </div>

          {activeTabId === "setup" ? (
            <div className="workspace-panel workspace-panel-setup">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">First-time setup</span>
                  <h2>Access and shell</h2>
                  <p>Run these once. You can use the built-in Terminal or your local shell.</p>
                </div>
                <div className="panel-controls">
                  <label className="setup-target-switch">
                    <span>Run in</span>
                    <select value={setupCommandTarget} onChange={(event) => setSetupCommandTarget(event.target.value as SetupCommandMode)}>
                      <option value="builtInTerminal">Built-in Terminal</option>
                      <option value="localShell">Local shell</option>
                    </select>
                  </label>
                  <button
                    className="panel-action"
                    onClick={() => {
                      setTerminalTarget(nextTerminalTarget);
                      setSelectedSurface("terminal");
                      setSelectedThreadId(null);
                    }}
                  >
                    Open terminal
                  </button>
                </div>
              </div>
              <section className="setup-guide-shell">
                <section className="setup-guide" aria-label="First-time setup">
                  <div className="setup-guide-steps">
                    {shell.butler.onboarding.steps.map((step) => {
                      const commandSet =
                        step.commandSets.find((entry) => entry.target === (setupCommandTarget === "localShell" ? "localShell" : step.id === "butlerAuth" ? "butlerTerminal" : "codexTerminal")) ??
                        step.commandSets.find((entry) => entry.target !== "localShell") ??
                        step.commandSets[0];

                      return (
                        <section key={step.id} className={`setup-step is-${step.status}`}>
                          <div className="setup-step-head">
                            <span className="setup-step-title">{step.title}</span>
                            <span className="setup-step-status">{onboardingStatusLabel(step.status)}</span>
                          </div>
                          <p className="setup-step-detail">{step.detail}</p>
                          <p className="setup-step-context">{commandSet.detail}</p>
                          {commandSet.commands.length > 0 ? (
                            <div className="setup-step-commands">
                              {commandSet.commands.map((command) => {
                                const key = `${step.id}-${setupCommandTarget}-${command}`;
                                return (
                                  <button key={key} type="button" className={`setup-command ${copiedCommandKey === key ? "is-copied" : ""}`} onClick={() => void copySetupCommand(command, key)} aria-label={`Copy command for ${step.title}`}>
                                    <code>{command}</code>
                                    <span className="setup-command-copy" aria-hidden="true">
                                      <CopyIcon />
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
                </section>
              </section>
            </div>
          ) : activeTabId === "terminal" ? null : activeTabId === "butler" ? (
            <ButlerSurface
              onOpenThread={openThread}
              onPreviewMedia={setPreviewMedia}
              composerPrefill={composerPrefill}
              onComposerPrefillConsumed={handleComposerPrefillConsumed}
              showToast={showToast}
              showErrorToast={showErrorToast}
              copyText={copyText}
            />
          ) : activeTabId === "scratchPad" ? (
            <div className="workspace-panel workspace-panel-scratch-pad">
              <ScratchPadPanel
                variant="window"
                scratchPad={shell.butler.scratchPad}
                onOpenThread={openThread}
                showToast={showToast}
                showErrorToast={showErrorToast}
              />
            </div>
          ) : (
            <ThreadSurface
              threadId={activeThreadId}
              onPreviewMedia={setPreviewMedia}
              onOpenThread={openThread}
              onDeleteThread={confirmDeleteThread}
              onDeleteProof={confirmDeleteProof}
              composerPrefill={composerPrefill}
              onComposerPrefillConsumed={handleComposerPrefillConsumed}
              showToast={showToast}
              showErrorToast={showErrorToast}
              copyText={copyText}
            />
          )}
        </section>
      </main>

      <div className={`threads-backdrop ${threadsDrawerOpen ? "is-open" : ""}`} onClick={() => setThreadsDrawerOpen(false)} aria-hidden={threadsDrawerOpen ? "false" : "true"} />
      <aside className={`threads-drawer ${threadsDrawerOpen ? "is-open" : ""}`}>
        <div className="threads-drawer-head">
          <div>
            <h2>Codex threads</h2>
          </div>
          <div className="threads-drawer-actions">
            <button className="threads-drawer-delete" onClick={() => confirmDeleteAllThreads()} disabled={shell.codex.threads.length === 0} aria-label="Delete all threads" title="Delete all threads">
              <TrashIcon />
            </button>
            <button className="threads-drawer-close" onClick={() => setThreadsDrawerOpen(false)} aria-label="Close threads drawer" title="Close">
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="threads-drawer-body">
          {visibleCodexThreads.length === 0 ? (
            <div className="empty threads-drawer-empty">No Codex threads are available yet.</div>
          ) : (
            visibleCodexThreads.map((thread) => {
              const callback = callbackByThreadId.get(thread.id) ?? null;
              const callbackState = describeCallbackState(callback);
              return (
                <div key={thread.id} className={`thread-row ${shell.codex.focusedWindowId === thread.id ? "is-active" : ""}`}>
                  <button
                    className="thread-row-main"
                    onClick={() => {
                      setThreadsDrawerOpen(false);
                      openThread(thread.id);
                    }}
                  >
                    <div className="thread-row-top">
                      <div className="thread-row-statuses">
                        <span className={`job-status is-${thread.status}`}>{describeStatus(thread.status)}</span>
                        {callbackState ? <span className={`thread-callback-status is-${callbackState.tone}`}>{callbackState.label}</span> : null}
                      </div>
                      <span className="job-time">{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(thread.updatedAt)}</span>
                    </div>
                    <strong>{formatThreadTitle(thread)}</strong>
                    <span className="thread-row-summary">{thread.supervisor.summary}</span>
                    <div className="thread-row-meta">
                      <span className="thread-row-project">{thread.supervisor.projectLabel}</span>
                      <span className="thread-row-id" title={thread.id}>{formatJobIdLabel(thread.id)}</span>
                    </div>
                  </button>
                  <button className="thread-row-delete" onClick={() => confirmDeleteThread(thread.id)} aria-label="Delete thread" title="Delete thread">
                    <TrashIcon />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {confirmDialog ? (
        <div className="modal-backdrop" onClick={() => (!confirmBusy ? setConfirmDialog(null) : undefined)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 id="confirm-dialog-title">{confirmDialog.title}</h2>
              <button className="modal-close" onClick={() => setConfirmDialog(null)} disabled={confirmBusy} aria-label="Close confirmation">
                <CloseIcon />
              </button>
            </div>
            <p className="modal-copy">{confirmDialog.message}</p>
            <div className="modal-actions">
              <button className="panel-action" onClick={() => setConfirmDialog(null)} disabled={confirmBusy}>
                Cancel
              </button>
              <button className="panel-action panel-action-danger" onClick={() => void handleConfirmAction()} disabled={confirmBusy}>
                {confirmBusy ? "Deleting…" : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewMedia
        ? previewMedia.kind === "video"
          ? (
              <div className="modal-backdrop" onClick={() => setPreviewMedia(null)}>
                <div className="modal-card modal-card-image modal-card-video" role="dialog" aria-modal="true" aria-labelledby="image-preview-title" onClick={(event) => event.stopPropagation()}>
                  <div className="modal-head">
                    <h2 id="image-preview-title">{previewMedia.name}</h2>
                    <div className="modal-head-actions">
                      {previewMedia.downloadUrl ? (
                        <a className="panel-action panel-action-link" href={previewMedia.downloadUrl} download>
                          Download
                        </a>
                      ) : null}
                      <button className="modal-close" onClick={() => setPreviewMedia(null)} aria-label="Close image preview">
                        <CloseIcon />
                      </button>
                    </div>
                  </div>
                  <div className="modal-image-shell">
                    <video src={previewMedia.url} className="modal-video" controls playsInline preload="metadata" />
                  </div>
                </div>
              </div>
            )
          : (
              <ImagePreviewModal
                media={previewMedia}
                attachTargetLabel={composerPrefillTargetLabel}
                onAttached={handleAnnotatedProofAttached}
                onClose={() => setPreviewMedia(null)}
                showErrorToast={showErrorToast}
              />
            )
        : null}

      {toast ? (
        <div className="toast-region" aria-live="polite" aria-atomic="true">
          <div className={`toast-card is-${toast.tone}`}>
            <div className="toast-copy">{toast.message}</div>
            <button className="toast-dismiss" onClick={() => setToast(null)} aria-label="Dismiss notification">
              <CloseIcon />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
