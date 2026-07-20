import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { redactSensitiveText } from "./redact-sensitive-text.js";
import type { AgentSkillChangeInput, AgentSkillChangeProposal, SkillEnvironmentId, SkillScope } from "./skills-service.js";
import { deleteWorkerThread, startWorkerThread } from "./worker-client-router.js";

const environmentSchema = Type.Union([
  Type.Literal("butler-pi"),
  Type.Literal("worker-pi")
]);

function environment(value: unknown): SkillEnvironmentId {
  if (value === "butler-pi" || value === "worker-pi") return value;
  throw new Error("Unknown skill environment.");
}

function scope(value: unknown): SkillScope {
  return value === "project" ? "project" : "user";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [];
  const items = value.map(text).filter(Boolean);
  if (items.length > 20 || items.some((item) => item.length > 1000)) throw new Error(`${label} is too large.`);
  return items;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  const presentProposal = async (proposal: AgentSkillChangeProposal) => {
    const approval = access.skillsService.agentApprovalOptions(proposal.id);
    const action = proposal.operation === "undo" ? "Undo change" : proposal.operation === "install" ? "Publish skill" : proposal.operation === "update" ? "Update skill" : "Create skill";
    const sourceStatus = proposal.sourceVerification === "butler-prepared"
      ? "prepared and exercised by Butler in scratch; Manor validated this exact candidate"
      : "agent-reported; Manor did not fetch or verify this source";
    const message = await access.postOperatorQuestion({
      questions: [{
        prompt: proposal.summary,
        context: [
          `Purpose: ${proposal.description}`,
          `Source: ${proposal.operation === "install" ? `${proposal.source} (${sourceStatus})` : proposal.source ?? "Butler-authored"}`,
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
    return { message, action };
  };

  return [
    access.defineButlerTool({
      name: "inspect_skills",
      label: "Inspect skills",
      description: "List, search, or read installed skills for Butler or Worker without changing them.",
      promptSnippet: "inspect_skills: use this before proposing a skill install, creation, or update. Set environment to exactly butler-pi or worker-pi; never guess another id. Search installed skills first and read a matching skill before changing it.",
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
      name: "propose_repository_skill_install",
      label: "Publish prepared skill",
      description: "Run the final verification command against a Butler-prepared skill directory, validate and package it, then ask the operator to approve publication to the shared registry.",
      promptSnippet: "propose_repository_skill_install: after using bash to clone, inspect, build, and prepare a repository skill under /scratch, provide the final skill directory and a real verification or doctor command. Manor reruns that command, packages the directory itself, validates it, and asks for approval. Any unresolved dependency blocks publication. Worker is used only after publication for fresh-session confirmation.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1 }),
        source: Type.String({ minLength: 1 }),
        candidatePath: Type.String({ minLength: 1 }),
        verificationCommand: Type.String({ minLength: 1, maxLength: 32_768 }),
        setupCommands: Type.Optional(Type.Array(Type.String())),
        dependencies: Type.Optional(Type.Array(Type.String()))
      }),
      uiEffects: access.getToolUiEffects("propose_repository_skill_install"),
      execute: async (_toolCallId, params, signal) => {
        if (!access.butlerExecutorClient) throw new Error("Butler executor is unavailable.");
        const dependencies = textList(params.dependencies, "Dependencies");
        if (dependencies.length > 0) throw new Error("The prepared skill still has unresolved runtime dependencies and cannot be published.");
        const candidatePath = text(params.candidatePath);
        const verificationCommand = text(params.verificationCommand);
        const name = text(params.name);
        const sealed = await access.skillsService.sealButlerSkillCandidate(name, candidatePath);
        let verification;
        let proposal;
        try {
          verification = await access.butlerExecutorClient.execute({
            script: `cd -- ${shellQuote(sealed.verificationPath)} && ${verificationCommand}`,
            timeoutMs: 120_000,
            threadId: access.runtimeThreadId,
            signal
          });
          if (verification.exitCode !== 0 || verification.timedOut) {
            throw new Error(`Prepared skill verification failed with exit ${verification.exitCode}. ${verification.stderr || verification.stdout}`.trim());
          }
          await access.skillsService.assertSealedButlerSkillCandidateUnchanged(name, sealed.verificationPath, sealed.archiveBase64);
          const setupCommands = textList(params.setupCommands, "Setup commands");
          const evidence = redactSensitiveText([
            `Prepared by Butler session: ${access.runtimeThreadId}`,
            `Source: ${text(params.source)}`,
            `Candidate directory: ${candidatePath}`,
            `Setup commands:\n${setupCommands.length ? setupCommands.map((item) => `- ${item}`).join("\n") : "- none"}`,
            `Final verification against sealed candidate: ${verificationCommand} (exit ${verification.exitCode})`,
            verification.stdout ? `Verification output:\n${verification.stdout}` : "",
            "Remaining dependencies:\n- none"
          ].filter(Boolean).join("\n"));
          proposal = await access.skillsService.proposeButlerPreparedInstall(access.runtimeThreadId, {
            name,
            source: redactSensitiveText(text(params.source)),
            candidatePath,
            candidateArchiveBase64: sealed.archiveBase64,
            evidence
          });
        } finally {
          await sealed.cleanup();
        }
        const { message } = await presentProposal(proposal);
        return {
          content: [{ type: "text", text: `Prepared skill ${proposal.id} is awaiting operator approval for the shared registry. After approval, call apply_skill_change with this proposal id.` }],
          details: { proposal, verification, question: message.question }
        };
      }
    }),
    access.defineButlerTool({
      name: "propose_skill_change",
      label: "Propose skill change",
      description: "Prepare a validated single-document skill create, install, update, or undo and ask the operator to approve it. Repository-backed installations use Butler scratch preparation.",
      promptSnippet: "propose_skill_change: after inspecting existing skills, use this for single-document creation, installation, update, or undo in the shared registry. Include the complete SKILL.md for a single-document install. For a repository or multi-file skill, prepare it under /scratch and use propose_repository_skill_install. Project-local skills are repository files and must be changed by Worker. Never call apply_skill_change until the operator approves the card.",
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
        const { message } = await presentProposal(proposal);
        return {
          content: [{ type: "text", text: `Skill change proposal ${proposal.id} is awaiting operator approval. After approval, call apply_skill_change with this proposal id.` }],
          details: { proposal, question: message.question }
        };
      }
    }),
    access.defineButlerTool({
      name: "confirm_worker_skill_operability",
      label: "Confirm Worker skill operability",
      description: "Mark a published shared skill ready only after its bound fresh Worker session loads and exercises it successfully.",
      promptSnippet: "confirm_worker_skill_operability: use only for the fresh verification job started by apply_skill_change. The latest completed report must name the installed skill invocation and include a successful command. This posts the final ready result to the operator.",
      parameters: Type.Object({
        resultId: Type.String({ minLength: 1 }),
        threadId: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("confirm_worker_skill_operability"),
      execute: async (_toolCallId, params) => {
        const resultId = text(params.resultId);
        const threadId = text(params.threadId);
        const pending = access.skillsService.getAgentResult(access.runtimeThreadId, resultId);
        if (pending.verification.operability !== "verification-pending" || pending.verification.verificationThreadId !== threadId) {
          throw new Error("This Worker is not bound to the pending skill verification.");
        }
        const payload = access.store.getThreadJobPayload(threadId);
        if (!payload || payload.protocol.butlerThreadId !== access.getButlerSessionId() || payload.protocol.workerThreadId !== threadId) {
          throw new Error("The skill verification Worker does not belong to the current Butler session.");
        }
        const latestTurn = access.store.getThread(threadId)?.turns.at(-1);
        const report = access.store.getWorkerReport(threadId);
        if (!latestTurn || latestTurn.startedAt < pending.appliedAt || !report || report.status !== "completed" || report.turnId !== latestTurn.id) {
          throw new Error("The fresh Worker must submit a completed report for its latest verification turn.");
        }
        const reportText = [report.summary, report.details, ...report.evidence.flatMap((entry) => [entry.summary, entry.details, entry.command])]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        if (!reportText.includes(pending.verification.invocation) || !report.evidence.some((entry) => entry.command && entry.exitCode === 0)) {
          throw new Error("The fresh Worker report must name the installed invocation and include a successful operational command.");
        }
        const ready = access.skillsService.confirmAgentResultVerification(access.runtimeThreadId, resultId, threadId);
        await access.postOperatorJobReply(threadId, `Installed skill ${ready.skill.name} is ready. A fresh Worker loaded ${ready.verification.invocation} and exercised the installed capability successfully.`);
        return {
          content: [{ type: "text", text: `Confirmed ${ready.skill.name} is operational in a fresh Worker session.` }],
          details: { result: ready }
        };
      }
    }),
    access.defineButlerTool({
      name: "apply_skill_change",
      label: "Apply skill change",
      description: "Apply one server-approved shared skill proposal, schedule Butler reload, and return undo or fresh Worker verification details.",
      promptSnippet: "apply_skill_change: call this only after the operator approved the matching proposal card. The server rejects unapproved, rejected, expired, cross-session, or stale proposals.",
      parameters: Type.Object({ proposalId: Type.String({ minLength: 1 }) }),
      uiEffects: access.getToolUiEffects("apply_skill_change"),
      execute: async (_toolCallId, params) => {
        let result = await access.skillsService.applyApprovedAgentChange(access.runtimeThreadId, text(params.proposalId));
        if (result.verification.resourceReload === "scheduled") access.scheduleButlerSkillReload();
        if (result.verification.operability === "verification-pending") {
          if (!result.verification.verificationThreadId) {
            try {
              const defaults = access.getWorkerDefaults?.();
              if (!defaults?.model) throw new Error("No connected Worker model is available for skill confirmation.");
              const instruction = `Fresh-session confirmation for shared skill ${result.skill.name}, change result ${result.id}. Load ${result.verification.invocation}, inspect the installed skill, and exercise its real entrypoint or doctor flow. Do not modify the shared registry. Submit a completed Manor report only if the capability works. The report must include ${result.verification.invocation} and a successful operational command with exit code 0.`;
              let verificationThreadId: string;
              if (defaults.threadId) {
                await access.createOrUpdateJobPayload({ threadId: defaults.threadId, kind: "steering", instruction });
                const replacement = await access.handoffWorker({
                  sourceThreadId: defaults.threadId,
                  harness: "pi",
                  model: defaults.model,
                  effort: (defaults.effort ?? null) as never,
                  butlerThreadId: access.getButlerSessionId(),
                  cwd: defaults.cwd ?? null
                });
                verificationThreadId = replacement.threadId;
              } else {
                const started = await startWorkerThread(access, {
                  task: `Confirm shared skill ${result.skill.name}`,
                  input: async (threadId) => {
                    await access.createOrUpdateJobPayload({ threadId, kind: "delegation", instruction });
                    return [{ type: "text", text: instruction }];
                  },
                  cwd: defaults.cwd ?? "/repos",
                  effort: (defaults.effort ?? null) as never,
                  openWindow: true,
                  runtime: "pi-rpc",
                  harness: "pi",
                  model: defaults.model
                });
                const attached = access.queueDelegationAcknowledgement(started.threadId, `Published ${result.skill.name}. Worker ${started.threadId} is independently confirming it.`, {
                  runtime: started.runtime,
                  harness: started.harness,
                  provider: started.provider,
                  model: started.model,
                  effort: started.effort
                });
                if (attached?.attached === false) {
                  await deleteWorkerThread(access, started.threadId).catch(() => false);
                  throw new Error("This Butler session already has a Worker and could not attach the confirmation job.");
                }
                await access.registerPendingChatCallback(started.threadId);
                access.noteThreadFocus(started.threadId, "skill verification");
                verificationThreadId = started.threadId;
              }
              result = access.skillsService.bindAgentResultVerification(access.runtimeThreadId, result.id, verificationThreadId);
            } catch (error) {
              throw new Error(`Published ${result.skill.name}, but fresh Worker verification could not start. The skill remains verification-pending. ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          return {
            content: [{ type: "text", text: `Published ${result.skill.name}. Operability verification is pending in fresh Worker job ${result.verification.verificationThreadId}; do not call it ready until confirm_worker_skill_operability succeeds.` }],
            details: { result }
          };
        }
        return {
          content: [{ type: "text", text: `${result.operation === "undo" ? "Undid change for" : "Applied skill change for"} ${result.skill.name}. Verification: catalog ${result.verification.catalogVisible ? "contains the skill" : "no longer contains the skill"}; invocation ${result.verification.invocation}; ${result.verification.resourceReload === "scheduled" ? "Butler resource reload scheduled." : "New Worker sessions will load the change; replace an existing Worker session if needed."} ${result.undo.available ? `Undo reference: ${result.undo.resultId}.` : result.undo.instruction}` }],
          details: { result }
        };
      }
    })
  ];
}
