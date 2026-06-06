const TIMING_FOOTER_PATTERN = /\n\n_Task time \((Butler|Codex)\): [^_]+_$/;

export function stripElapsedTaskTimeFooter(text: string): string {
  return text.replace(TIMING_FOOTER_PATTERN, "");
}

export function formatElapsedTaskTime(durationMs: number): string {
  const safeDurationMs = Math.max(0, Math.floor(durationMs));
  const totalSeconds = Math.round(safeDurationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function elapsedTaskDurationMs(startedAt: number | null, completedAt: number | null): number | null {
  if (typeof startedAt !== "number" || typeof completedAt !== "number" || completedAt < startedAt) {
    return null;
  }

  return completedAt - startedAt;
}
