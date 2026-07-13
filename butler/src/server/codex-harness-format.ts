import type { CodexThreadRecord } from "./types.js";

export function formatHarnessExecutionContract(thread: CodexThreadRecord): string[] {
  const contract = thread.executionContract;
  if (!contract) {
    return ["Job brief: none"];
  }
  const acceptancePoints = Array.isArray(contract.acceptancePoints) ? contract.acceptancePoints : [];
  return [
    `Job workspace: ${contract.workspaceCwd ?? "(unknown)"}`,
    `Job branch: ${contract.branch ?? "(unknown)"}`,
    `Proof expectation: ${contract.proofExpectationLabel}`,
    ...(acceptancePoints.length > 0
      ? [`Acceptance points:\n${acceptancePoints.map((point, index) => `${index + 1}. ${point}`).join("\n")}`]
      : []),
    ...(contract.orchestration
      ? [
          [
            `Orchestration: class=${contract.orchestration.taskClass} risk=${contract.orchestration.riskLevel}`,
            `Goal mode: ${contract.orchestration.goalRecommendation.mode}`,
            `Adversarial review required: ${contract.orchestration.reviewRecommendation.required ? "yes" : "no"}`,
            contract.orchestration.subAgentRoles.length > 0 ? `Sub-agent roles: ${contract.orchestration.subAgentRoles.join(", ")}` : null
          ].filter(Boolean).join("\n")
        ]
      : []),
    ...(contract.notes.length > 0 ? [`Job notes:\n${contract.notes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`] : [])
  ];
}

export function formatHarnessRuntimeModel(): string[] {
  return [
    "Runtime rule: the Worker shell is only for source files, repository inspection, editing, and Git. Run all installs, builds, tests, scripts, servers, conversions, and project code in a preview through manor-harness.",
    "Uploaded inputs are mounted read-only at /inputs in both Worker and previews. Write derived files under /outputs/<jobId>, then publish them with manor-harness input publish <path> --from <referenceId> so Manor creates a linked immutable version.",
    "Previews run app code. Services provide supporting infrastructure such as databases, queues, object storage, or mail capture.",
    "Browser-use sessions already capture tracing, video, a ready screenshot, a final screenshot, and per-action screenshots unless you disable auto-capture.",
    "Choose proof that directly demonstrates the result. Frontend work usually benefits from screenshots or video plus test output; operational work is often best shown with a Markdown command transcript.",
    "Native Electron or VNC-visible desktop proof must use the desktop proof commands. Do not create a private Xvfb display when the operator needs to see the app in noVNC.",
    "For headed desktop work, list existing sessions first, attach the job thread id as the visible desktop workspace label, use current-screen before pointer actions, and use interactive/profile options when the operator needs a persistent desktop.",
    "If the browser proof sidecar is unavailable, retry briefly and then report the proof blocker through Manor. Do not install browsers or OS packages inside a preview as the default fallback.",
    "If the desktop proof sidecar is unavailable, check desktop status and report that the desktop profile must be started before native headed proof can proceed.",
    "Keep startup explicit. If the project needs install or run commands, choose and run them directly instead of waiting for Manor to infer them.",
    "After starting a preview, use preview wait for its ready or failed result. Startup logs, processes, and diagnostic exec remain available while it boots; inspect them before creating another preview.",
    "If the repo has its own AGENTS guidance for install or runtime shape, follow that guidance over these generic defaults."
  ];
}
