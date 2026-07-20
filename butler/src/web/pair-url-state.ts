import { SETTINGS_SECTIONS, type SettingsSectionId } from "./SettingsDashboard";

import type { PairViewMode } from "../shared/pairing";
import { DEFAULT_TERMINAL_TARGET, readInitialTerminalTarget, type TerminalTarget } from "../shared/terminal";

const VIEW_MODES = new Set<PairViewMode>(["butler", "worker", "split", "files", "memory", "improve", "settings", "cli"]);
const SETTINGS_SECTION_IDS = new Set<SettingsSectionId>(SETTINGS_SECTIONS.map((section) => section.id));

export type PairUrlState = {
  sessionId: string | null;
  viewMode: PairViewMode;
  settingsSection: SettingsSectionId;
  terminalTarget: TerminalTarget;
};

export type PairUrlHistory = Pick<History, "pushState" | "replaceState">;
export type PairUrlHistoryMode = "push" | "replace";

export function readPairUrlState(href?: string): PairUrlState {
  const url = new URL(href ?? (typeof window === "undefined" ? "http://localhost/" : window.location.href));
  const [, prefix, section] = url.pathname.split("/");
  const requestedView = url.searchParams.get("view");
  const sessionId = url.searchParams.get("session")?.trim() || null;
  const viewMode = prefix === "settings"
    ? "settings"
    : requestedView && VIEW_MODES.has(requestedView as PairViewMode) ? requestedView as PairViewMode : "butler";

  return {
    sessionId,
    viewMode,
    settingsSection: prefix === "settings" && section === "network"
      ? "security"
      : prefix === "settings" && SETTINGS_SECTION_IDS.has(section as SettingsSectionId)
        ? section as SettingsSectionId
        : "runtime",
    terminalTarget: readInitialTerminalTarget(url.searchParams.get("terminal")) ?? DEFAULT_TERMINAL_TARGET
  };
}

export function buildPairUrl(href: string, state: PairUrlState): string {
  const url = new URL(href);
  if (state.sessionId) url.searchParams.set("session", state.sessionId);
  else url.searchParams.delete("session");

  if (state.viewMode === "settings") {
    url.pathname = `/settings/${state.settingsSection}`;
    url.searchParams.delete("view");
    url.searchParams.delete("terminal");
    if (state.settingsSection !== "providers") url.searchParams.delete("provider");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) url.pathname = "/";
  url.searchParams.delete("provider");
  if (state.viewMode === "butler") url.searchParams.delete("view");
  else url.searchParams.set("view", state.viewMode);
  if (state.viewMode === "cli" && state.terminalTarget !== DEFAULT_TERMINAL_TARGET) {
    url.searchParams.set("terminal", state.terminalTarget);
  } else {
    url.searchParams.delete("terminal");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function writePairUrl(history: PairUrlHistory, href: string, state: PairUrlState, mode: PairUrlHistoryMode): void {
  history[mode === "push" ? "pushState" : "replaceState"](null, "", buildPairUrl(href, state));
}
