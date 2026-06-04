import type { ButlerMessageView } from "./types.js";

export function upsertOperatorMessage(messages: ButlerMessageView[], id: string, text: string, at: number): void {
  const existingMessage = messages.find((entry) => entry.id === id);
  if (existingMessage) {
    existingMessage.text = text;
    existingMessage.at = at;
  } else {
    messages.push({
      id,
      role: "assistant",
      text,
      at,
      kind: "message"
    });
  }
  messages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  if (messages.length > 40) {
    messages.splice(0, messages.length - 40);
  }
}
