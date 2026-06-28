export type TerminalTarget = "butler" | "codex";

export const TERMINAL_TARGETS: TerminalTarget[] = ["butler", "codex"];

export const TERMINAL_LABELS: Record<TerminalTarget, string> = {
  butler: "Butler CLI",
  codex: "Codex CLI"
};

export const TERMINAL_URLS: Record<TerminalTarget, string> = {
  butler: "/butler-terminal/",
  codex: "/terminal/"
};

export function readInitialTerminalTarget(value: string | null): TerminalTarget | null {
  return value === "butler" || value === "codex" ? value : null;
}
