import { redactSensitiveText } from "./redact-sensitive-text.js";
import type { ButlerStateStore } from "./state-store.js";

const MAX_TURNS = 12;
const MAX_ITEMS_PER_TURN = 30;
const ITEM_TEXT_CHARS = 2_000;
const MAX_CHARS = 50_000;

function truncate(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[… ${omitted} characters omitted from ${label}]`;
}

export function buildJobDetail(store: ButlerStateStore, threadId: string): string {
  const thread = store.getThread(threadId);
  if (!thread) return `Job ${threadId} was not found.`;
  const lease = store.getThreadPreviewLease(threadId);
  const jobMemory = store.getJobMemory(threadId);
  const checklist = store.getSupervisionChecklist(threadId);
  const checklistSummary = checklist
    ? checklist.items.map((item) => `${item.id}:${item.status}:${item.text}`).join(" | ")
    : "(none)";

  const omittedTurnCount = Math.max(0, thread.turns.length - MAX_TURNS);
  const selectedTurns = thread.turns.slice(-MAX_TURNS);
  const runtimeErrors = thread.eventLog.filter((entry) => /(?:^|[./])runtime[./]error$/i.test(entry.method) && entry.summary.trim());
  let omittedItemCount = 0;
  const turns = selectedTurns.map((turn, turnIndex) => {
    const selectedItems = turn.items.slice(-MAX_ITEMS_PER_TURN);
    const omittedItemsForTurn = Math.max(0, turn.items.length - selectedItems.length);
    omittedItemCount += omittedItemsForTurn;
    const items = selectedItems.map((item, itemIndex) => {
      const text = truncate(redactSensitiveText(item.text), ITEM_TEXT_CHARS, "job item text");
      return `${omittedTurnCount + turnIndex + 1}.${omittedItemsForTurn + itemIndex + 1} ${item.type} (${item.status}) ${text}`.trim();
    }).join("\n");
    const nextTurnStartedAt = selectedTurns[turnIndex + 1]?.startedAt ?? null;
    const diagnosticWindowEnd = nextTurnStartedAt ?? (turn.completedAt ? turn.completedAt + 10_000 : Number.POSITIVE_INFINITY);
    const diagnosticLines = [
      ...(turn.error?.trim() ? [`turn_error=${truncate(redactSensitiveText(turn.error), ITEM_TEXT_CHARS, "turn error")}`] : []),
      ...runtimeErrors
        .filter((entry) => entry.at >= turn.startedAt && entry.at <= diagnosticWindowEnd)
        .slice(0, 4)
        .reverse()
        .map((entry) => `runtime_error@${new Date(entry.at).toISOString()}=${truncate(redactSensitiveText(entry.summary), ITEM_TEXT_CHARS, "runtime error")}`)
    ].filter((entry, index, entries) => entries.indexOf(entry) === index);
    const diagnostics = diagnosticLines.length > 0 ? `\n${diagnosticLines.join("\n")}` : "";
    const omittedItems = omittedItemsForTurn > 0 ? `\n[${omittedItemsForTurn} earlier items omitted from this turn.]` : "";
    return `Turn ${omittedTurnCount + turnIndex + 1} | id=${turn.id} | status=${turn.status}${diagnostics}${omittedItems}\n${items}`;
  }).join("\n\n");

  const detail = [
    `Job ${thread.id}`,
    `project=${thread.supervisor.projectLabel}`,
    `status=${thread.status}`,
    `source=${thread.source}`,
    `task=${thread.supervisor.latestUserPrompt ?? thread.executionContract?.requestedTask ?? "(empty)"}`,
    `contract=${thread.executionContract ? "present" : "none"}`,
    `checklist=${checklistSummary}`,
    lease ? `operator_preview=${lease.operatorUrl}` : "operator_preview=(none)",
    `summary=${thread.supervisor.summary}`,
    jobMemory?.latestCheckpoint ? `latest_checkpoint=${jobMemory.latestCheckpoint}` : "latest_checkpoint=(none)",
    jobMemory?.nextAction ? `next_action=${jobMemory.nextAction}` : "next_action=(none)",
    jobMemory && jobMemory.blockers.length > 0 ? `blockers=${jobMemory.blockers.join(" | ")}` : "blockers=(none)",
    jobMemory && jobMemory.promotionCandidates.length > 0
      ? `promotion_candidates=${jobMemory.promotionCandidates.map((candidate) => `${candidate.kind}:${candidate.status}:${candidate.summary}`).join(" | ")}`
      : "promotion_candidates=(none)",
    omittedTurnCount > 0 ? `omitted_earlier_turns=${omittedTurnCount}` : null,
    omittedItemCount > 0 ? `omitted_earlier_items=${omittedItemCount}` : null,
    turns || "No turn details loaded yet."
  ].filter((entry): entry is string => typeof entry === "string").join("\n");
  return truncate(redactSensitiveText(detail), MAX_CHARS, "job detail");
}
