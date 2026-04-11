import type { CodexThreadRecord } from "./types.js";

export function formatHarnessExecutionContract(thread: CodexThreadRecord): string[] {
  const contract = thread.executionContract;
  if (!contract) {
    return ["Execution contract: none"];
  }
  return [
    `Execution lane: ${contract.executionLaneLabel}`,
    `Contract workspace: ${contract.workspaceCwd ?? "(unknown)"}`,
    `Contract branch: ${contract.branch ?? "(unknown)"}`,
    `Proof mode: ${contract.proofModeLabel}`,
    ...(contract.notes.length > 0 ? [`Contract notes:\n${contract.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`] : [])
  ];
}

export function formatHarnessRuntimeModel(): string[] {
  return [
    "Runtime model: Manor owns preview lifecycle and isolation; the contract lane decides whether work stays in the shared shell, runs on the host, or moves into a preview.",
    "Repository bootstrap and git-only setup can stay in the shared shell. Use previews only when the contract lane or repo guidance actually requires isolated runtime execution.",
    "Previews run the app or job code. Services provide backing infrastructure such as databases, queues, object storage, or mail capture.",
    "Do not run the main app inside a service. If the app must execute, start or reuse a preview.",
    "When the contract lane is preview runtime, start a preview and use exec, logs, processes, inspect, and verify to adapt the app like a normal dev box.",
    "Keep startup explicit. Do not assume Manor will infer the right install command, shell shape, or health endpoint for the project.",
    "If the repo has its own AGENTS guidance for install or runtime shape, follow that repo guidance over these generic defaults unless the execution contract explicitly requires preview-only proof."
  ];
}
