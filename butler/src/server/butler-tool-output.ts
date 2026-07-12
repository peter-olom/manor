import { redactSensitiveText } from "./redact-sensitive-text.js";

const DEFAULT_MAX_CHARS = 8_000;

export function formatButlerToolOutput(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const redacted = redactSensitiveText(text).trim();
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars).trimEnd()}\n...[truncated]`;
}
