import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import type { AgentSkillChangeInput, SkillEnvironmentId, SkillScope } from "./skills-service.js";

const environmentSchema = Type.Union([
  Type.Literal("butler-pi"),
  Type.Literal("worker-pi"),
  Type.Literal("worker-codex")
]);

function environment(value: unknown): SkillEnvironmentId {
  if (value === "butler-pi" || value === "worker-pi" || value === "worker-codex") return value;
  throw new Error("Unknown skill environment.");
}

function scope(value: unknown): SkillScope {
  return value === "project" ? "project" : "user";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildChange(params: Record<string, unknown>): AgentSkillChangeInput {
  const operation = params.operation;
  if (operation === "undo") return { operation, resultId: text(params.resultId) };
  const shared = {
    environment: environment(params.environment),
    cwd: text(params.cwd) || null
  };
  if (operation === "update") {
    return {
      operation,
      ...shared,
      id: text(params.id),
      content: typeof params.content === "string" ? params.content : "",
      reason: text(params.reason)
    };
  }
  if (operation === "install") {
    return {
      operation,
      ...shared,
      name: text(params.name),
      content: typeof params.content === "string" ? params.content : "",
      source: text(params.source),
      scope: scope(params.scope)
    };
  }
  if (operation === "create") {
    return {
      operation,
      ...shared,
      name: text(params.name),
      description: text(params.description),
      instructions: typeof params.instructions === "string" ? params.instructions : "",
      scope: scope(params.scope)
    };
  }
  throw new Error("Skill operation must be create, install, update, or undo.");
}

export function buildButlerSkillTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "inspect_skills",
      label: "Inspect skills",
      description: "List, search, or read installed skills in butler-pi, worker-pi, or worker-codex without changing them.",
      promptSnippet: "inspect_skills: use this before proposing a skill install, creation, or update. Set environment to exactly butler-pi, worker-pi, or worker-codex; never guess another id. Search installed skills first and read a matching skill before changing it.",
      parameters: Type.Object({
        environment: environmentSchema,
        cwd: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        id: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("inspect_skills"),
      execute: async (_toolCallId, params) => {
        const environmentId = environment(params.environment);
        const cwd = text(params.cwd) || null;
        const id = text(params.id);
        if (id) {
          const skill = await access.skillsService.read(environmentId, id, cwd);
          return { content: [{ type: "text", text: `Installed skill ${skill.name} (${skill.scope}, ${skill.origin})\nInvocation: ${skill.invocation}\n\n${skill.content}` }], details: { skill } };
        }
        const query = text(params.query).toLowerCase();
        const skills = (await access.skillsService.list(environmentId, cwd)).filter((skill) =>
          !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query)
        );
        const summary = skills.length === 0
          ? "No installed skills matched."
          : skills.map((skill) => `${skill.id} | ${skill.name} | ${skill.scope}/${skill.origin} | ${skill.description}`).join("\n");
        return { content: [{ type: "text", text: summary }], details: { skills } };
      }
    }),
    access.defineButlerTool({
      name: "propose_skill_change",
      label: "Propose skill change",
      description: "Prepare a validated skill create, install, update, or undo in butler-pi, worker-pi, or worker-codex and ask the operator to approve it. This never mutates skills.",
      promptSnippet: "propose_skill_change: after inspecting existing skills, use this to present one explicit approval card. Set environment to exactly butler-pi, worker-pi, or worker-codex. Agent create, install, and update accept one complete SKILL.md only, up to 32 KiB, with no companion-file references. The conservative guard may reject ambiguous file-like instructions; use explicit https:// URLs and clearly qualify runtime-generated paths. Direct genuine multi-file skills to Settings → Skills → Advanced archive install. Install source is agent-reported; Manor does not fetch or attest it. Never call apply_skill_change until the operator approves the card.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("create"), Type.Literal("install"), Type.Literal("update"), Type.Literal("undo")]),
        environment: Type.Optional(environmentSchema),
        cwd: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        instructions: Type.Optional(Type.String()),
        id: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        source: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        resultId: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("propose_skill_change"),
      execute: async (_toolCallId, params) => {
        const proposal = await access.skillsService.proposeAgentChange(access.runtimeThreadId, buildChange(params));
        const approval = access.skillsService.agentApprovalOptions(proposal.id);
        const action = proposal.operation === "undo" ? "Undo change" : proposal.operation === "install" ? "Install and verify" : proposal.operation === "update" ? "Update skill" : "Create skill";
        const message = await access.postOperatorQuestion({
          questions: [{
            prompt: proposal.summary,
            context: [
              `Purpose: ${proposal.description}`,
              `Source: ${proposal.operation === "install" ? `${proposal.source} (agent-reported; Manor did not fetch or verify this source)` : proposal.source ?? "Butler-authored"}`,
              `Target: ${proposal.target}`,
              `Footprint: ${proposal.footprint}`,
              `Conflict check: ${proposal.conflict}`,
              `Verification: ${proposal.verificationPlan}`,
              `Approved content SHA-256: ${proposal.contentSha256}`,
              `Approved content evidence: ${proposal.contentEvidence}`
            ].join("\n"),
            options: [
              { id: approval.approve, label: action, description: "Approve this exact validated proposal." },
              { id: approval.reject, label: "Cancel", description: "Leave installed skills unchanged." }
            ],
            allowFreeform: false
          }]
        });
        const questionId = message.question.questions?.[0]?.id ?? message.question.id;
        access.skillsService.bindAgentProposalQuestion(access.runtimeThreadId, proposal.id, message.id, questionId);
        return {
          content: [{ type: "text", text: `Skill change proposal ${proposal.id} is awaiting operator approval. After approval, call apply_skill_change with this proposal id.` }],
          details: { proposal, question: message.question }
        };
      }
    }),
    access.defineButlerTool({
      name: "apply_skill_change",
      label: "Apply skill change",
      description: "Apply one server-approved skill proposal for butler-pi, worker-pi, or worker-codex, verify it, schedule the applicable resource reload, and return undo details.",
      promptSnippet: "apply_skill_change: call this only after the operator approved the matching proposal card for butler-pi, worker-pi, or worker-codex. The server rejects unapproved, rejected, expired, cross-session, or stale proposals.",
      parameters: Type.Object({ proposalId: Type.String({ minLength: 1 }) }),
      uiEffects: access.getToolUiEffects("apply_skill_change"),
      execute: async (_toolCallId, params) => {
        const result = await access.skillsService.applyApprovedAgentChange(access.runtimeThreadId, text(params.proposalId));
        if (result.verification.resourceReload === "scheduled") access.scheduleButlerSkillReload();
        return {
          content: [{ type: "text", text: `${result.operation === "undo" ? "Undid change for" : "Applied skill change for"} ${result.skill.name}. Verification: catalog ${result.verification.catalogVisible ? "contains the skill" : "no longer contains the skill"}; invocation ${result.verification.invocation}; ${result.verification.resourceReload === "scheduled" ? "Butler resource reload scheduled." : "New Worker sessions will load the change; replace an existing Worker session if needed."} ${result.undo.available ? `Undo reference: ${result.undo.resultId}.` : result.undo.instruction}` }],
          details: { result }
        };
      }
    })
  ];
}
