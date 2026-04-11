import type { DragEvent, ReactNode, DragEvent as ReactDragEvent } from "react";
import { isValidElement } from "react";

import type {
  ButlerThreadCallback,
  ButlerHistoryState,
  ButlerMessageRecord,
  ButlerThinkingLevel,
  CodexThreadSummary,
  CodexThreadDetail,
  ImageReference,
  PreviewBrowserMode,
  PreviewVerification,
  PreviewVerificationArtifact,
  PreviewableImage,
  RuntimeSnapshot,
  SetupCommandMode,
  TerminalTarget,
  ThemePreference,
  ThreadStatus,
  WorkspaceSurface
} from "./types";

export const THEME_STORAGE_KEY = "manor.butler.themePreference";
export const BUTLER_DRAFT_STORAGE_KEY = "manor.butler.draft";
export const THREAD_DRAFT_STORAGE_KEY_PREFIX = "manor.butler.threadDraft.";
export const BUTLER_RUNTIME_VISIBILITY_STORAGE_KEY = "manor.butler.showRuntime";
export const DRAFT_PERSIST_DELAY_MS = 180;
export const BUTLER_HISTORY_PAGE_SIZE = 250;
export const BUTLER_HISTORY_AUTOLOAD_THRESHOLD_PX = 240;

export function formatTime(value: number | null | undefined): string {
  if (!value) {
    return "Now";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

export function formatJumpLabel(value: number | null | undefined): string {
  if (!value) {
    return "Just now";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

export function formatLeaseState(
  lifecycleState: string | undefined,
  expiresAt: number | null | undefined,
  pinned: boolean | undefined
): string {
  if (pinned) {
    return "pinned";
  }
  if (!lifecycleState) {
    return "active";
  }
  if (lifecycleState === "idle" && expiresAt) {
    return `idle until ${formatTime(expiresAt)}`;
  }
  return lifecycleState;
}

export function formatPreviewBootstrap(lease: RuntimeSnapshot["previews"][number]): string {
  const heartbeatTarget = lease.bootstrap.heartbeatTarget ? ` • ${lease.bootstrap.heartbeatTarget}` : "";
  const lastHeartbeat = lease.bootstrap.lastHeartbeatAt ? ` • beat ${formatJumpLabel(lease.bootstrap.lastHeartbeatAt)}` : "";
  return `${lease.bootstrap.phase}${heartbeatTarget}${lastHeartbeat}`;
}

export function formatStackStorage(stack: RuntimeSnapshot["stacks"][number]): string {
  const bits = [`mode=${stack.storageMode}`];
  if (stack.storageKey) {
    bits.push(`key=${stack.storageKey}`);
  }
  if (stack.baseStorageKey) {
    bits.push(`base=${stack.baseStorageKey}`);
  }
  bits.push(`sticky=${stack.stickyVolumeCount}`);
  return bits.join(" • ");
}

export function formatVerificationDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "0s";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

export function formatVerificationSummary(verification: PreviewVerification): string {
  const bits = [
    verification.failureKind !== "none" ? verification.failureKind : null,
    verification.status ? `${verification.status}` : null,
    verification.mode === "headful" ? "Headed" : "Headless",
    formatVerificationDuration(verification.durationMs),
    verification.summary.consoleMessageCount > 0 ? `${verification.summary.consoleMessageCount} console` : null,
    verification.summary.failedRequestCount > 0 ? `${verification.summary.failedRequestCount} failed requests` : null,
    verification.summary.responseErrorCount > 0 ? `${verification.summary.responseErrorCount} response errors` : null,
    verification.summary.assetFailureCount > 0 ? `${verification.summary.assetFailureCount} asset failures` : null,
    verification.summary.pageErrorCount > 0 ? `${verification.summary.pageErrorCount} page errors` : null
  ].filter(Boolean);
  return bits.join(" • ");
}

export function previewVerificationActionLabel(
  mode: PreviewBrowserMode,
  busy:
    | {
        leaseId: string;
        mode: PreviewBrowserMode;
      }
    | null,
  leaseId: string,
  compact = false
): string {
  if (!busy || busy.leaseId !== leaseId || busy.mode !== mode) {
    if (compact) {
      return mode === "headful" ? "Headed" : "Verify";
    }
    return mode === "headful" ? "Verify headed" : "Verify preview";
  }

  return busy.mode === "headful" ? "Verifying…" : "Checking…";
}

export function findVerificationArtifact(
  verification: PreviewVerification,
  kind: PreviewVerificationArtifact["kind"]
): PreviewVerificationArtifact | null {
  return verification.artifacts.find((artifact) => artifact.kind === kind) ?? null;
}

export function describeArtifactAvailability(artifact: PreviewVerificationArtifact): {
  available: boolean;
  label: string;
  detail: string | null;
} {
  if (artifact.availability === "available") {
    return { available: true, label: artifact.label, detail: null };
  }

  if (artifact.availability === "expired") {
    return {
      available: false,
      label: `${artifact.label} expired`,
      detail: "This proof file aged out after the 14 day retention window."
    };
  }

  return {
    available: false,
    label: `${artifact.label} missing`,
    detail: "The proof record still exists, but the file is gone."
  };
}

export function formatTimelineDayLabel(value: number | null | undefined): string {
  if (!value) {
    return "Today";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(value);
}

export function getTimelineDayKey(value: number | null | undefined): string {
  if (!value) {
    return "unknown-day";
  }

  return new Date(value).toISOString().slice(0, 10);
}

export function groupTimelineItems<T extends { id: string; text: string; at: number | null }>(items: T[]) {
  const groups = new Map<string, { key: string; label: string; firstId: string; items: T[] }>();

  for (const item of items) {
    const key = getTimelineDayKey(item.at);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label: formatTimelineDayLabel(item.at),
      firstId: item.id,
      items: [item]
    });
  }

  return [...groups.values()];
}

export function dedupeMessages(messages: ButlerMessageRecord[]): ButlerHistoryState["messages"] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

export function formatCompactCount(value: number | null): string {
  return value && value > 0 ? `${value}` : "Auto";
}

export function formatContextUsage(contextUsage: {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}): string {
  if (contextUsage.percent === null || contextUsage.percent === undefined) {
    return "Unknown";
  }

  const usagePercent = `${Math.round(contextUsage.percent)}%`;
  if (!contextUsage.tokens || !contextUsage.contextWindow) {
    return usagePercent;
  }

  const used = `${(contextUsage.tokens / 1000).toFixed(1)}k`;
  const total = `${(contextUsage.contextWindow / 1000).toFixed(0)}k`;
  return `${usagePercent} • ${used} / ${total}`;
}

export function formatCompactionState(compaction: {
  active: boolean;
  count: number;
  lastReason: string | null;
}): string {
  if (compaction.active) {
    return "Compacting";
  }

  if (compaction.count > 0) {
    return `${compaction.count} runs`;
  }

  return "Auto";
}

export function formatThreadBudget(supervision: { butlerTurnsUsed: number; maxButlerTurns: number | null }): string {
  return supervision.maxButlerTurns === null ? `${supervision.butlerTurnsUsed} turns` : `${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns} turns`;
}

export function formatJobIdLabel(threadId: string | null | undefined): string {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return "Job";
  }

  if (normalizedThreadId.length <= 13) {
    return `Job ${normalizedThreadId}`;
  }

  return `Job ${normalizedThreadId.slice(0, 8)}-${normalizedThreadId.slice(-4)}`;
}

export function formatCodexCompactionState(compaction: {
  active: boolean;
  count: number;
}): string {
  if (compaction.active) {
    return "Compacting";
  }

  return compaction.count > 0 ? `${compaction.count}` : "Auto";
}

export function describeStatus(status: ThreadStatus): string {
  if (status === "active") {
    return "Working";
  }
  if (status === "idle") {
    return "Idle";
  }
  return "Unknown";
}

export function formatThreadTitle(thread: Pick<CodexThreadSummary, "preview" | "supervisor" | "executionContract">): string {
  const candidates = [
    thread.executionContract?.requestedTask,
    thread.supervisor.latestUserPrompt,
    thread.preview.startsWith("AUTHORITATIVE JOB CONTRACT") ? null : thread.preview
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "Untitled run";
}

export function describeCallbackState(
  callback: ButlerThreadCallback | null | undefined
): { label: string; tone: "waiting" | "recovered" | "closed" | "missing" } | null {
  if (!callback) {
    return null;
  }

  if (callback.callbackState === "missing_worker_callback") {
    return { label: "Recovering", tone: "missing" };
  }

  if (callback.owesOperatorReply) {
    return { label: "Awaiting callback", tone: "waiting" };
  }

  if (callback.resolutionState === "recovered_from_thread_state") {
    return { label: "Recovered", tone: "recovered" };
  }

  return { label: "Closed", tone: "closed" };
}

export function itemTone(type: string): "user" | "assistant" | "system" {
  if (type === "userMessage") {
    return "user";
  }
  if (type === "agentMessage") {
    return "assistant";
  }
  return "system";
}

export function itemLabel(type: string): string {
  if (type === "userMessage") {
    return "You";
  }
  if (type === "agentMessage") {
    return "Codex";
  }
  return type;
}

export function shouldRenderItem(item: { type: string; text: string }): boolean {
  if (item.type !== "agentMessage" && item.type !== "userMessage") {
    return false;
  }
  return Boolean(item.text.trim());
}

export function onboardingStatusLabel(status: "complete" | "pending"): string {
  return status === "complete" ? "Done" : "Pending";
}

export function flattenNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenNodeText(child)).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenNodeText(node.props.children);
  }

  return "";
}

export function extractCodeLanguage(children: ReactNode): string {
  const firstChild = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(firstChild)) {
    return "";
  }

  const className = typeof firstChild.props.className === "string" ? firstChild.props.className : "";
  const match = className.match(/language-([a-z0-9#+-]+)/i);
  return match?.[1] ?? "";
}

export function formatAttachmentSummary(count: number): string {
  return count === 1 ? "Attached 1 reference image." : `Attached ${count} reference images.`;
}

export function extractReferencedImages(text: string, knownImages: ImageReference[]): PreviewableImage[] {
  const lines = text.split("\n");
  const images: PreviewableImage[] = [];
  let collecting = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "Stored reference images:" || line === "Attached reference images:") {
      collecting = true;
      continue;
    }

    if (!collecting) {
      continue;
    }

    if (!line) {
      continue;
    }

    if (!line.startsWith("- ")) {
      break;
    }

    const body = line.slice(2).trim();
    const separator = body.indexOf("|");
    if (separator !== -1) {
      const id = body.slice(0, separator).trim();
      const name = body.slice(separator + 1).trim();
      if (!id || !name) {
        continue;
      }

      images.push({
        id,
        name,
        url: `/api/images/${encodeURIComponent(id)}`
      });
      continue;
    }

    const match = [...knownImages].reverse().find((image) => image.name === body);
    if (!match) {
      continue;
    }

    images.push({
      id: match.id,
      name: match.name,
      url: match.url
    });
  }

  return images;
}

export function stripReferencedImagesSection(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "Stored reference images:" || line === "Attached reference images:") {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (!line) {
        continue;
      }

      if (line.startsWith("- ")) {
        continue;
      }

      skipping = false;
    }

    kept.push(rawLine);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isImageDrag(event: DragEvent | ReactDragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.items].some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

export function readStoredValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(key) ?? "";
}

export function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (value) {
    window.localStorage.setItem(key, value);
    return;
  }

  window.localStorage.removeItem(key);
}

export function readWorkspaceQuery(): {
  surface: WorkspaceSurface | null;
  threadId: string | null;
  terminalTarget: TerminalTarget;
} {
  if (typeof window === "undefined") {
    return { surface: null, threadId: null, terminalTarget: "codexTerminal" };
  }

  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const terminal = params.get("terminal");
  const threadId = params.get("thread");

  return {
    surface: view === "setup" || view === "butler" || view === "terminal" || view === "thread" ? view : null,
    threadId: threadId ? threadId : null,
    terminalTarget: terminal === "butler" ? "butlerTerminal" : "codexTerminal"
  };
}

export function buildWorkspaceQuery(state: { surface: WorkspaceSurface; threadId: string | null; terminalTarget: TerminalTarget }): string {
  const params = new URLSearchParams();
  params.set("view", state.surface);
  params.set("terminal", state.terminalTarget === "butlerTerminal" ? "butler" : "codex");

  if (state.surface === "thread" && state.threadId) {
    params.set("thread", state.threadId);
  }

  return `?${params.toString()}`;
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea || typeof window === "undefined") {
    return;
  }

  const computedStyle = window.getComputedStyle(textarea);
  const minHeight = Number.parseFloat(computedStyle.minHeight) || 0;
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 24;
  const paddingBlock =
    (Number.parseFloat(computedStyle.paddingTop) || 0) +
    (Number.parseFloat(computedStyle.paddingBottom) || 0) +
    (Number.parseFloat(computedStyle.borderTopWidth) || 0) +
    (Number.parseFloat(computedStyle.borderBottomWidth) || 0);
  const maxHeight = lineHeight * 8 + paddingBlock;

  textarea.style.height = "0px";
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function scrollElementToLatest(element: HTMLDivElement | null) {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

export function scrollElementToCenteredTarget(container: HTMLDivElement | null, target: HTMLElement | null) {
  if (!container || !target) {
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const offsetWithinContainer = targetRect.top - containerRect.top;
  const centeredTop = container.scrollTop + offsetWithinContainer - (container.clientHeight - targetRect.height) / 2;
  container.scrollTop = Math.max(0, centeredTop);
}

export function dedupePreviewableImages(images: PreviewableImage[]): PreviewableImage[] {
  const next = new Map<string, PreviewableImage>();
  for (const image of images) {
    next.set(image.id, image);
  }
  return [...next.values()];
}

export function buildMessageImageLookup(
  rows: Array<{ id: string; text: string; includeImages: boolean }>,
  knownImages: ImageReference[]
): Record<string, { displayText: string; images: PreviewableImage[] }> {
  return Object.fromEntries(
    rows.map((row) => {
      if (!row.includeImages) {
        return [row.id, { displayText: row.text || "…", images: [] }];
      }

      const images = dedupePreviewableImages(extractReferencedImages(row.text || "", knownImages));
      const displayText = images.length > 0 ? stripReferencedImagesSection(row.text || "") || "…" : row.text || "…";
      return [row.id, { displayText, images }];
    })
  );
}

export function resolveSetupCommandTarget(target: SetupCommandMode, nextTerminalTarget: TerminalTarget): "localShell" | "butlerTerminal" | "codexTerminal" {
  if (target === "localShell") {
    return "localShell";
  }
  return nextTerminalTarget;
}

export function isThreadWorking(
  pendingThreadRequest: {
    threadId: string;
  } | null,
  activeThread: CodexThreadDetail | null
): boolean {
  return Boolean(pendingThreadRequest && activeThread && pendingThreadRequest.threadId === activeThread.id) || activeThread?.status === "active";
}

export function resolveThemePreference(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  return preference === "light" || (preference === "system" && !systemPrefersDark);
}
