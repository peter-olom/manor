import type { ShellSnapshot, ThreadStatus } from "./types";

export type CompletionSoundSnapshot = {
  butlerBusy: boolean;
  threadStatuses: Record<string, ThreadStatus>;
};

type FaviconState = {
  created: boolean;
  href: string | null;
  link: HTMLLinkElement;
};

type BrowserAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

const COMPLETION_TITLE_PREFIX = "[Done] ";
const COMPLETION_FAVICON_HREF =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23111111'/%3E%3Ccircle cx='16' cy='16' r='10' fill='%23ffb020'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23ffffff'/%3E%3C/svg%3E";

let audioContext: AudioContext | null = null;
let tabAttentionCleanup: (() => void) | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (audioContext) {
    return audioContext;
  }

  const AudioContextConstructor = window.AudioContext ?? (window as BrowserAudioWindow).webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }

  audioContext = new AudioContextConstructor();
  return audioContext;
}

function scheduleTone(context: AudioContext, startAt: number, frequency: number, duration: number, volume: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

export function installCompletionSoundUnlock(): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const unlock = () => {
    const context = getAudioContext();
    if (!context) {
      return;
    }
    void context.resume().catch(() => undefined);
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };

  window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  window.addEventListener("keydown", unlock, { capture: true });

  return () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
}

export function playCompletionNotificationSound(): void {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  const play = () => {
    const now = context.currentTime + 0.025;
    scheduleTone(context, now, 660, 0.14, 0.18);
    scheduleTone(context, now + 0.11, 880, 0.16, 0.16);
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => undefined);
    return;
  }

  play();
}

function getFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  return document.querySelector<HTMLLinkElement>("link[rel~='icon']");
}

function setCompletionFavicon(): FaviconState | null {
  if (typeof document === "undefined") {
    return null;
  }

  const existingLink = getFaviconLink();
  const link = existingLink ?? document.createElement("link");
  const state = {
    created: !existingLink,
    href: link.getAttribute("href"),
    link
  };

  if (!existingLink) {
    link.rel = "icon";
    document.head.appendChild(link);
  }

  link.href = COMPLETION_FAVICON_HREF;
  return state;
}

function restoreFavicon(state: FaviconState | null): void {
  if (!state) {
    return;
  }

  if (state.created) {
    state.link.remove();
    return;
  }

  if (state.href) {
    state.link.href = state.href;
    return;
  }

  state.link.removeAttribute("href");
}

export function buildCompletionTabAlertTitle(title: string, active: boolean): string {
  const baseTitle = title.startsWith(COMPLETION_TITLE_PREFIX) ? title.slice(COMPLETION_TITLE_PREFIX.length) : title;
  return active ? `${COMPLETION_TITLE_PREFIX}${baseTitle}` : baseTitle;
}

export function flashCompletionBrowserTab(durationMs = 12000): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  tabAttentionCleanup?.();

  const originalTitle = document.title;
  const faviconState = setCompletionFavicon();
  let active = true;
  let restored = false;
  let intervalId = 0;
  let timeoutId = 0;

  const render = () => {
    document.title = buildCompletionTabAlertTitle(originalTitle, active);
    active = !active;
  };

  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    window.clearInterval(intervalId);
    window.clearTimeout(timeoutId);
    window.removeEventListener("focus", restore);
    window.removeEventListener("pointerdown", restore, true);
    window.removeEventListener("keydown", restore, true);
    document.removeEventListener("visibilitychange", restoreWhenVisible);
    document.title = originalTitle;
    restoreFavicon(faviconState);
    if (tabAttentionCleanup === restore) {
      tabAttentionCleanup = null;
    }
  };

  const restoreWhenVisible = () => {
    if (!document.hidden) {
      restore();
    }
  };

  render();
  intervalId = window.setInterval(render, 800);
  timeoutId = window.setTimeout(restore, durationMs);
  tabAttentionCleanup = restore;

  window.addEventListener("focus", restore);
  window.addEventListener("pointerdown", restore, { capture: true, passive: true });
  window.addEventListener("keydown", restore, { capture: true });
  document.addEventListener("visibilitychange", restoreWhenVisible);

  return restore;
}

export function buildCompletionSoundSnapshot(shell: ShellSnapshot): CompletionSoundSnapshot {
  return {
    butlerBusy: shell.butler.pending || shell.butler.isStreaming,
    threadStatuses: Object.fromEntries(shell.codex.threads.map((thread) => [thread.id, thread.status]))
  };
}

export function shouldPlayCompletionNotificationSound(
  previous: CompletionSoundSnapshot | null,
  next: CompletionSoundSnapshot
): boolean {
  if (!previous) {
    return false;
  }

  if (previous.butlerBusy && !next.butlerBusy) {
    return true;
  }

  return Object.entries(next.threadStatuses).some(
    ([threadId, status]) => previous.threadStatuses[threadId] === "active" && status !== "active"
  );
}
