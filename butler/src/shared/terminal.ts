export type TerminalTarget = "butler" | "worker";

export const DEFAULT_TERMINAL_TARGET: TerminalTarget = "worker";
export const TERMINAL_TARGETS: TerminalTarget[] = ["butler", "worker"];

export const TERMINAL_LABELS: Record<TerminalTarget, string> = {
  butler: "Butler CLI",
  worker: "Worker CLI"
};

export const TERMINAL_URLS: Record<TerminalTarget, string> = {
  butler: "/butler-terminal/",
  worker: "/terminal/"
};

export function readInitialTerminalTarget(value: string | null): TerminalTarget | null {
  if (value === "butler") return "butler";
  if (value === "worker") return "worker";
  return null;
}
