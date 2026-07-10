import { inferTaskCategory, inferWorkDepth } from "./thread-contract.js";
import type { ButlerRoutingDecisionView } from "./types.js";

export function buildDelegationRoutingDecision(input: {
  task: string;
  goal?: string | null;
}): ButlerRoutingDecisionView {
  const taskText = [input.task, input.goal ?? ""].filter(Boolean).join("\n");
  const taskClass = inferTaskCategory(taskText);
  const depth = inferWorkDepth(taskText, taskClass);
  const highRisk = taskClass === "deploy" || depth === "incident" || /\b(prod|production|secret|payment|migration|delete|security)\b/i.test(taskText);
  const reviewRequired = true;
  const longWork = depth === "deep" || depth === "incident";

  return {
    taskClass,
    confidence: 0.75,
    questionSet: [],
    goalRecommendation: longWork
      ? { mode: "native_goal", goal: input.goal ?? input.task, fallbackReason: null }
      : { mode: "none", goal: null, fallbackReason: null },
    reviewRecommendation: {
      target: "adversarial_review",
      required: reviewRequired,
      reason: "Butler reviews every completed worker job before acceptance."
    },
    subAgentRoles: highRisk ? ["adversarial-review"] : [],
    riskLevel: highRisk ? "high" : reviewRequired ? "medium" : "low",
    fallbackReason: null,
    createdAt: Date.now()
  };
}
