import type { ButlerMessageView } from "./types.js";

export function upsertOperatorMessage(messages: ButlerMessageView[], id: string, text: string, at: number, taskDurationMs: number | null = null): void {
  const existingMessage = messages.find((entry) => entry.id === id);
  if (existingMessage) {
    existingMessage.text = text;
    existingMessage.at = at;
    existingMessage.taskDurationMs = taskDurationMs;
  } else {
    messages.push({
      id,
      role: "assistant",
      text,
      at,
      taskDurationMs,
      kind: "message"
    });
  }
  messages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  if (messages.length > 40) {
    messages.splice(0, messages.length - 40);
  }
}
