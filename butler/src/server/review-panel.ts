import type {
  CodexTaskCategory,
  CodexThreadExecutionContractView,
  ReviewPanelRole,
  ReviewPanelRunView,
  ReviewPanelSummaryView,
  ReviewPanelVerdict
} from "./types.js";

const ROLE_DEFINITIONS: Record<ReviewPanelRole, { label: string; scope: string; prompt: string }> = {
  intent: {
    label: "Intent reviewer",
    scope: "Operator intent, constraints, and actual requested outcome.",
    prompt: "Check whether the worker preserved the operator's real ask, constraints, tone, and expected outcome."
  },
  qa: {
    label: "QA reviewer",
    scope: "Tests, smoke coverage, failure paths, and evidence gaps.",
    prompt: "Check verification depth, missing negative cases, fragile evidence, and whether claims are backed by proof."
  },
  ui_taste: {
    label: "UI taste reviewer",
    scope: "Visual hierarchy, responsiveness, accessibility, copy, and polish.",
    prompt: "Check rendered state, hierarchy, interaction fit, accessible basics, responsive behavior, and copy quality."
  },
  api: {
    label: "API reviewer",
    scope: "Endpoint behavior, negative cases, logs, data effects, and operational clarity.",
    prompt: "Check request behavior, persistence, failure handling, logs, and whether API claims were smoke tested."
  },
  ops: {
    label: "Ops reviewer",
    scope: "Deploy, restart, logs, rollback notes, and live health.",
    prompt: "Check deploy or restart evidence, health checks, log review, rollback clarity, and live-system risk."
  },
  product: {
    label: "Product reviewer",
    scope: "Usefulness, coherence, workflow fit, and whether the result is worth acting on.",
    prompt: "Check whether the outcome is coherent, useful, operator-ready, and grounded in the actual product need."
  }
};

function uniqueRoles(roles: ReviewPanelRole[]): ReviewPanelRole[] {
  return [...new Set(roles)];
}

export function selectReviewPanelRoles(input: {
  taskCategory: CodexTaskCategory;
  inferredWorkDepth: string;
  requestedTask: string;
  attachmentCount?: number;
}): ReviewPanelRole[] {
  const normalized = input.requestedTask.toLowerCase();
  const roles: ReviewPanelRole[] = ["intent"];

  if (input.taskCategory === "ui") {
    roles.push("qa", "ui_taste");
  } else if (input.taskCategory === "api" || input.taskCategory === "data") {
    roles.push("qa", "api");
  } else if (input.taskCategory === "deploy") {
    roles.push("qa", "ops");
  } else if (input.taskCategory === "generic_code" || input.taskCategory === "prototype") {
    roles.push("qa", "product");
  } else if (
    input.taskCategory === "research" ||
    input.taskCategory === "plan" ||
    input.taskCategory === "recommendation" ||
    input.taskCategory === "docs" ||
    input.taskCategory === "writing" ||
    input.taskCategory === "unknown"
  ) {
    roles.push("product");
  }

  if (/\b(api|endpoint|graphql|database|schema|migration|logs?)\b/i.test(normalized)) {
    roles.push("api");
  }
  if (/\b(ui|screen|visual|browser|component|responsive|accessibility|copy)\b/i.test(normalized)) {
    roles.push("ui_taste");
  }
  if (/\b(deploy|restart|production|staging|live|rollback|health)\b/i.test(normalized)) {
    roles.push("ops");
  }
  if ((input.attachmentCount ?? 0) > 0 || input.inferredWorkDepth === "deep" || input.inferredWorkDepth === "incident") {
    roles.push("qa");
  }

  return uniqueRoles(roles);
}

export function buildReviewPanel(input: {
  taskCategory: CodexTaskCategory;
  inferredWorkDepth: string;
  requestedTask: string;
  attachmentCount?: number;
  createdAt?: number;
}): ReviewPanelRunView[] {
  const createdAt = input.createdAt ?? Date.now();
  return selectReviewPanelRoles(input).map((role) => {
    const definition = ROLE_DEFINITIONS[role];
    return {
      id: `review-${role}`,
      role,
      label: definition.label,
      scope: definition.scope,
      trigger: `${input.taskCategory} / ${input.inferredWorkDepth}`,
      prompt: definition.prompt,
      verdict: "pending",
      concerns: [],
      evidenceRefs: [],
      requiredFollowUp: null,
      reviewerNote: null,
      modelProvider: null,
      modelId: null,
      createdAt,
      reviewedAt: null,
      updatedAt: createdAt
    };
  });
}

function normalizeVerdict(value: unknown): ReviewPanelVerdict {
  return value === "passed" || value === "concern" || value === "failed" || value === "blocked" ? value : "pending";
}

function normalizeStringList(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        .map((entry) => entry.trim())
        .slice(0, limit)
    : [];
}

export function normalizeReviewPanel(
  value: unknown,
  fallback: {
    taskCategory: CodexTaskCategory;
    inferredWorkDepth: string;
    requestedTask: string;
    attachmentCount?: number;
    createdAt?: number;
  }
): ReviewPanelRunView[] {
  const fallbackPanel = buildReviewPanel(fallback);
  const fallbackByRole = new Map(fallbackPanel.map((panel) => [panel.role, panel]));
  const incoming = Array.isArray(value) ? value : [];
  const normalized = incoming
    .filter((entry): entry is Partial<ReviewPanelRunView> => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const role = entry.role;
      if (role !== "intent" && role !== "qa" && role !== "ui_taste" && role !== "api" && role !== "ops" && role !== "product") {
        return null;
      }
      const base = fallbackByRole.get(role) ?? buildReviewPanel({ ...fallback, taskCategory: "unknown" }).find((panel) => panel.role === role);
      if (!base) {
        return null;
      }
      const verdict = normalizeVerdict(entry.verdict);
      return {
        ...base,
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : base.id,
        label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : base.label,
        scope: typeof entry.scope === "string" && entry.scope.trim() ? entry.scope.trim() : base.scope,
        trigger: typeof entry.trigger === "string" && entry.trigger.trim() ? entry.trigger.trim() : base.trigger,
        prompt: typeof entry.prompt === "string" && entry.prompt.trim() ? entry.prompt.trim() : base.prompt,
        verdict,
        concerns: normalizeStringList(entry.concerns),
        evidenceRefs: normalizeStringList(entry.evidenceRefs, 20),
        requiredFollowUp: typeof entry.requiredFollowUp === "string" && entry.requiredFollowUp.trim() ? entry.requiredFollowUp.trim() : null,
        reviewerNote: typeof entry.reviewerNote === "string" && entry.reviewerNote.trim() ? entry.reviewerNote.trim() : null,
        modelProvider: typeof entry.modelProvider === "string" && entry.modelProvider.trim() ? entry.modelProvider.trim() : null,
        modelId: typeof entry.modelId === "string" && entry.modelId.trim() ? entry.modelId.trim() : null,
        createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : base.createdAt,
        reviewedAt: typeof entry.reviewedAt === "number" && Number.isFinite(entry.reviewedAt) ? entry.reviewedAt : null,
        updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : base.updatedAt
      } satisfies ReviewPanelRunView;
    })
    .filter((entry): entry is ReviewPanelRunView => Boolean(entry));
  const byRole = new Map<ReviewPanelRole, ReviewPanelRunView>();
  for (const panel of [...fallbackPanel, ...normalized]) {
    byRole.set(panel.role, panel);
  }
  return [...byRole.values()];
}

export function summarizeReviewPanel(panel: ReviewPanelRunView[]): ReviewPanelSummaryView {
  const passed = panel.filter((entry) => entry.verdict === "passed").length;
  const concerns = panel.filter((entry) => entry.verdict === "concern").length;
  const blocking = panel.filter((entry) => entry.verdict === "failed" || entry.verdict === "blocked").length;
  const pending = panel.filter((entry) => entry.verdict === "pending").length;
  const status = blocking > 0 ? "blocked" : concerns > 0 ? "concerns" : pending > 0 ? "pending" : "passed";
  const updatedAt = panel.reduce<number | null>((latest, entry) => Math.max(latest ?? 0, entry.updatedAt), null);
  const challenged = panel
    .filter((entry) => entry.concerns.length > 0 || entry.requiredFollowUp)
    .map((entry) => `${entry.label}: ${entry.requiredFollowUp ?? entry.concerns[0]}`)
    .slice(0, 4);
  return {
    status,
    reviewers: panel.length,
    passed,
    concerns,
    blocking,
    summary:
      challenged.length > 0
        ? challenged.join("; ")
        : panel.length > 0
          ? `${passed}/${panel.length} reviewers passed${pending > 0 ? `, ${pending} pending` : ""}.`
          : null,
    updatedAt
  };
}

export function recordReviewPanelVerdict(
  contract: CodexThreadExecutionContractView,
  input: {
    role: ReviewPanelRole;
    verdict: ReviewPanelVerdict;
    concerns?: string[];
    evidenceRefs?: string[];
    requiredFollowUp?: string | null;
    note?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
  }
): CodexThreadExecutionContractView {
  const now = Date.now();
  const panel = normalizeReviewPanel(contract.reviewPanel, {
    taskCategory: contract.taskCategory,
    inferredWorkDepth: contract.inferredWorkDepth,
    requestedTask: contract.requestedTask
  }).map((entry) =>
    entry.role === input.role
      ? {
          ...entry,
          verdict: input.verdict,
          concerns: normalizeStringList(input.concerns),
          evidenceRefs: normalizeStringList(input.evidenceRefs, 20),
          requiredFollowUp: typeof input.requiredFollowUp === "string" && input.requiredFollowUp.trim() ? input.requiredFollowUp.trim() : null,
          reviewerNote: typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
          modelProvider: typeof input.modelProvider === "string" && input.modelProvider.trim() ? input.modelProvider.trim() : entry.modelProvider,
          modelId: typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : entry.modelId,
          reviewedAt: now,
          updatedAt: now
        }
      : entry
  );
  return {
    ...contract,
    reviewPanel: panel,
    reviewPanelSummary: summarizeReviewPanel(panel)
  };
}

export function getReviewPanelCloseoutBlocker(contract: CodexThreadExecutionContractView | null | undefined): string | null {
  const blocked = contract?.reviewPanel.find((entry) => entry.verdict === "failed" || entry.verdict === "blocked");
  if (!blocked) {
    return null;
  }
  return `${blocked.label} blocked closeout${blocked.requiredFollowUp ? `: ${blocked.requiredFollowUp}` : "."}`;
}
