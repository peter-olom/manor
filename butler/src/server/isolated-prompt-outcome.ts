import { redactSensitiveText } from "./redact-sensitive-text.js";

function latestAssistantMessage(messages: readonly unknown[]): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
      return message as Record<string, unknown>;
    }
  }
  return null;
}

export function assertIsolatedPromptSucceeded(messages: readonly unknown[], label: string): void {
  const assistant = latestAssistantMessage(messages);
  if (assistant?.stopReason !== "error") return;
  const detail = typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
    ? redactSensitiveText(assistant.errorMessage.trim()).slice(0, 2000)
    : `${label} failed without provider diagnostics.`;
  throw new Error(detail);
}
