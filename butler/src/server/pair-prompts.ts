import type { PairChat } from "../shared/pairing.js";

function compact(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function latestButlerContext(pair: PairChat): string[] {
  return pair.messages
    .filter((message) => message.lane === "butler" && message.role !== "system")
    .slice(-8)
    .map((message) => `${message.role}: ${compact(message.text).slice(0, 900)}`);
}

export function buildPairWorkerDeveloperInstructions(pair: PairChat): string {
  return [
    `You are the only Codex worker paired with Butler chat ${pair.id}.`,
    "Work adversarially with Butler: challenge weak assumptions, report uncertainty, and provide evidence before asking Butler to accept a result.",
    "Do not report to any global Butler chat. Revert only to the paired Butler chat by submitting a structured worker report or by answering the paired handoff.",
    "When blocked, say exactly what is blocked, what was tried, and what Butler should decide next.",
    "Keep the handoff contract tight. Do not duplicate hidden memory unless it changes the decision."
  ].join("\n");
}

export function buildPairWorkerPrompt(input: {
  pair: PairChat;
  task: string;
  memoryText: string;
  operatorText?: string | null;
}): string {
  const contextLines = latestButlerContext(input.pair);
  return [
    "BUTLER PAIR HANDOFF",
    `pair_id: ${input.pair.id}`,
    input.pair.projectLabel ? `project: ${input.pair.projectLabel}` : null,
    input.pair.defaultCwd ? `workspace: ${input.pair.defaultCwd}` : null,
    "",
    "TASK",
    compact(input.task),
    "",
    "PAIR MEMORY",
    input.memoryText.trim() || "No relevant memory retrieved.",
    "",
    contextLines.length > 0 ? "RECENT BUTLER CONTEXT" : null,
    ...contextLines,
    "",
    "ADVERSARIAL CONTRACT",
    "- Find the strongest practical answer, not the easiest agreeable answer.",
    "- Push back on Butler if the request is underspecified, unsafe, circular, or weakly verified.",
    "- Return evidence, commands, files, screenshots, or exact blockers as appropriate.",
    "- End with a concise worker report for Butler: status, summary, evidence, risks, and next Butler decision."
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function buildPairButlerReflection(input: { task: string; memoryText: string; hasWorker: boolean }): string {
  return [
    input.hasWorker ? "I added this to the paired context and can hand it to the existing worker." : "I added this to pair memory. This chat can attach one Codex worker when the task is ready.",
    input.memoryText.trim() ? "Relevant memory is available for the handoff." : "No strong prior memory matched this turn.",
    compact(input.task).length > 0 ? `Current handoff focus: ${compact(input.task).slice(0, 280)}` : null
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
