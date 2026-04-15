import type { CodexThreadRecord } from "./types.js";

export function formatHarnessExecutionContract(thread: CodexThreadRecord): string[] {
  const contract = thread.executionContract;
  if (!contract) {
    return ["Execution contract: none"];
  }
  return [
    `Contract workspace: ${contract.workspaceCwd ?? "(unknown)"}`,
    `Contract branch: ${contract.branch ?? "(unknown)"}`,
    `Proof mode: ${contract.proofModeLabel}`,
    ...(contract.notes.length > 0 ? [`Contract notes:\n${contract.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`] : [])
  ];
}

export function formatHarnessRuntimeModel(): string[] {
  return [
    "Runtime model: do repository, git, and code-editing work in Codex-shell; use Manor previews, stacks, and services when the task needs execution or verification.",
    "Repository bootstrap and git-only setup stay in Codex-shell until the task actually needs runtime work.",
    "Previews run the app or job code. Services provide backing infrastructure such as databases, queues, object storage, or mail capture.",
    "Do not run the main app inside a service. If the app must execute, start or reuse a preview.",
    "When the target is already online, use the direct browser tools instead of starting a local preview just for proof.",
    "Keep startup explicit. Do not assume Manor will infer the right install command, shell shape, or health endpoint for the project.",
    "If the repo has its own AGENTS guidance for install or runtime shape, follow that repo guidance over these generic defaults unless the execution contract explicitly requires a different proof obligation."
  ];
}
