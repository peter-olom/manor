import { inferTaskCategory, inferWorkDepth } from "./thread-contract.js";
import type { ButlerRoutingDecisionView } from "./types.js";

export function buildFallbackRoutingDecision(input: {
  task: string;
  goal?: string | null;
  fallbackReason: string;
}): ButlerRoutingDecisionView {
  const taskText = [input.task, input.goal ?? ""].filter(Boolean).join("\n");
  const taskClass = inferTaskCategory(taskText);
  const depth = inferWorkDepth(taskText, taskClass);
  const highRisk = taskClass === "deploy" || depth === "incident" || /\b(prod|production|secret|payment|migration|delete|security)\b/i.test(taskText);
  const reviewRequired =
    highRisk ||
    depth === "deep" ||
    taskClass === "ui" ||
    taskClass === "api" ||
    taskClass === "data" ||
    taskClass === "generic_code" ||
    taskClass === "prototype";
  const longWork = depth === "deep" || depth === "incident";

  return {
    taskClass,
    confidence: 0.45,
    questionSet: [],
    goalRecommendation: longWork
      ? { mode: "native_goal", goal: input.goal ?? input.task, fallbackReason: input.fallbackReason }
      : { mode: "none", goal: null, fallbackReason: null },
    reviewRecommendation: {
      target: reviewRequired ? "codex_review" : "none",
      required: reviewRequired,
      reason: reviewRequired ? "Heuristic fallback requires review for this risk profile." : null
    },
    subAgentRoles: highRisk ? ["adversarial-review"] : [],
    riskLevel: highRisk ? "high" : reviewRequired ? "medium" : "low",
    fallbackReason: input.fallbackReason,
    createdAt: Date.now()
  };
}
