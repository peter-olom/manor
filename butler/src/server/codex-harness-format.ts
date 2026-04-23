import type { CodexThreadRecord } from "./types.js";

export function formatHarnessExecutionContract(thread: CodexThreadRecord): string[] {
  const contract = thread.executionContract;
  if (!contract) {
    return ["Job brief: none"];
  }
  return [
    `Job workspace: ${contract.workspaceCwd ?? "(unknown)"}`,
    `Job branch: ${contract.branch ?? "(unknown)"}`,
    `Proof expectation: ${contract.proofExpectationLabel}`,
    ...(contract.notes.length > 0 ? [`Job notes:\n${contract.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`] : [])
  ];
}

export function formatHarnessRuntimeModel(): string[] {
  return [
    "Runtime model: use Codex-shell for repository and code work; use manor-harness only when the task needs a running app, disposable dependency, browser interaction, or durable proof.",
    "Previews run app code. Services provide supporting infrastructure such as databases, queues, object storage, or mail capture.",
    "Browser-use sessions already capture tracing, video, a ready screenshot, a final screenshot, and per-action screenshots unless you disable auto-capture.",
    "Keep startup explicit. If the project needs install or run commands, choose and run them directly instead of waiting for Manor to infer them.",
    "If the repo has its own AGENTS guidance for install or runtime shape, follow that guidance over these generic defaults."
  ];
}
