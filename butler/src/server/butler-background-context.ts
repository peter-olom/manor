export const BUTLER_BACKGROUND_PROMPT_PREFIX = "[[BUTLER_BACKGROUND]]";
export const BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX = "[[BUTLER_EPHEMERAL_BACKGROUND]]";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((entry) => entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" ? entry.text : "").join("\n");
}

export function isButlerBackgroundPromptText(text: string | null | undefined): boolean {
  return typeof text === "string" && (
    text.trimStart().startsWith(BUTLER_BACKGROUND_PROMPT_PREFIX) ||
    text.trimStart().startsWith(BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX)
  );
}

export function stripEphemeralButlerTurns<T>(messages: T[]): { messages: T[]; changed: boolean } {
  let dropping = false;
  const kept: T[] = [];
  for (const message of messages) {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : null;
    const role = typeof record?.role === "string" ? record.role : null;
    const startsEphemeral = (role === "user" || role === "user-with-attachments") &&
      contentText(record?.content).trimStart().startsWith(BUTLER_EPHEMERAL_BACKGROUND_PROMPT_PREFIX);
    if (startsEphemeral) {
      dropping = true;
      continue;
    }
    if (dropping && (role === "user" || role === "user-with-attachments")) dropping = false;
    if (!dropping) kept.push(message);
  }
  return kept.length === messages.length ? { messages, changed: false } : { messages: kept, changed: true };
}
