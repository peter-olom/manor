export type TaskTimeLabel = "Butler" | "Codex";

const TIMING_FOOTER_PATTERN = /\n\n_Task time \((Butler|Codex)\): [^_]+_$/;

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

export function appendElapsedTaskTime(text: string, startedAt: number | null, completedAt: number | null, label: TaskTimeLabel): string {
  if (!text.trim() || typeof startedAt !== "number" || typeof completedAt !== "number" || completedAt < startedAt) {
    return text;
  }

  const stripped = text.replace(TIMING_FOOTER_PATTERN, "");
  return `${stripped}\n\n_Task time (${label}): ${formatElapsedTaskTime(completedAt - startedAt)}_`;
}
