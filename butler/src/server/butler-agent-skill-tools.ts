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
      ? "prepared by Butler in scratch; Manor sealed and validated this exact candidate, with operational proof assigned by goal"
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
          `Worker verification goal: ${proposal.workerVerificationGoal ?? "Not required"}`,
          `Runtime requirements: ${proposal.runtimeRequirements.length ? proposal.runtimeRequirements.join("; ") : "No additional requirements identified"}`,
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
      description: "Seal a Butler-prepared skill, record Butler's goal-led validation, and assign independent Worker verification before requesting publication approval.",
      promptSnippet: "propose_repository_skill_install: your goal is to prepare a publishable skill that a Worker can use for the capability the repository promises. Work from the repository, its skill instructions, available tooling, and observed results. Clone or fetch into a fresh isolated directory under /scratch for this attempt; never reuse an earlier candidate. Decide the appropriate package shape and preparation method yourself. Skills may be instructions, scripts, binaries, generated assets, remote integrations, or another form, so do not assume a conventional layout. State the candidateValidationGoal and candidateValidationEvidence that support your judgment. Provide candidateValidationCommand only when rerunning a command against the sealed candidate is a meaningful check; do not invent one for a skill with another proof shape, and never mask failure with `|| true`, unconditional success, or discarded exit status. Use localOperationalCommand only when Butler can meaningfully exercise the capability; otherwise omit it and explain the relevant runtime requirements. Give Worker a representative verification goal derived from the skill's intended user outcome, not an installation mechanic such as catalog visibility or invocation loading. Manor seals the exact candidate and preserves safety, approval, and integrity boundaries; Butler and Worker own semantic correctness. After this tool posts the approval card, end the turn immediately. Do not call apply_skill_change or ask another question; the operator answer arrives in a new turn.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1 }),
        source: Type.String({ minLength: 1 }),
        candidatePath: Type.String({ minLength: 1 }),
        candidateValidationGoal: Type.String({ minLength: 1, maxLength: 2_000 }),
        candidateValidationEvidence: Type.String({ minLength: 1, maxLength: 8_000 }),
        candidateValidationCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
        localOperationalCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
        workerVerificationGoal: Type.String({ minLength: 1, maxLength: 2_000 }),
        runtimeRequirements: Type.Optional(Type.Array(Type.String())),
        setupCommands: Type.Optional(Type.Array(Type.String())),
        dependencies: Type.Optional(Type.Array(Type.String()))
      }),
      uiEffects: access.getToolUiEffects("propose_repository_skill_install"),
      execute: async (_toolCallId, params, signal) => {
        if (!access.butlerExecutorClient) throw new Error("Butler executor is unavailable.");
        const runtimeRequirements = [...new Set([
          ...textList(params.runtimeRequirements, "Runtime requirements"),
          ...textList(params.dependencies, "Legacy dependencies")
        ])];
        const candidatePath = text(params.candidatePath);
        const candidateValidationGoal = text(params.candidateValidationGoal);
        const candidateValidationEvidence = text(params.candidateValidationEvidence);
        const candidateValidationCommand = text(params.candidateValidationCommand);
        const localOperationalCommand = text(params.localOperationalCommand);
        const workerVerificationGoal = text(params.workerVerificationGoal);
        const name = text(params.name);
        if (!candidateValidationGoal) throw new Error("Candidate validation goal is required.");
        if (!candidateValidationEvidence) throw new Error("Candidate validation evidence is required.");
        if (!workerVerificationGoal) throw new Error("Worker operational verification goal is required.");
        const sealed = await access.skillsService.sealButlerSkillCandidate(name, candidatePath);
        let candidateValidation = null;
        let localOperationalVerification = null;
        let proposal;
        try {
          if (candidateValidationCommand) {
            candidateValidation = await access.butlerExecutorClient.execute({
              script: `cd -- ${shellQuote(sealed.verificationPath)} && ${candidateValidationCommand}`,
              timeoutMs: 120_000,
              threadId: access.runtimeThreadId,
              signal
            });
            if (candidateValidation.exitCode !== 0 || candidateValidation.timedOut) {
              throw new Error(`Prepared skill candidate validation failed with exit ${candidateValidation.exitCode}. ${candidateValidation.stderr || candidateValidation.stdout}`.trim());
            }
          }
          if (localOperationalCommand) {
            localOperationalVerification = await access.butlerExecutorClient.execute({
              script: `cd -- ${shellQuote(sealed.verificationPath)} && ${localOperationalCommand}`,
              timeoutMs: 120_000,
              threadId: access.runtimeThreadId,
              signal
            });
            if (localOperationalVerification.exitCode !== 0 || localOperationalVerification.timedOut) {
              throw new Error(`Prepared skill local operational verification failed with exit ${localOperationalVerification.exitCode}. ${localOperationalVerification.stderr || localOperationalVerification.stdout}`.trim());
            }
          }
          await access.skillsService.assertSealedButlerSkillCandidateUnchanged(name, sealed.verificationPath, sealed.archiveBase64);
          const setupCommands = textList(params.setupCommands, "Setup commands");
          const evidence = redactSensitiveText([
            `Prepared by Butler session: ${access.runtimeThreadId}`,
            `Source: ${text(params.source)}`,
            `Candidate directory: ${candidatePath}`,
            `Setup commands:\n${setupCommands.length ? setupCommands.map((item) => `- ${item}`).join("\n") : "- none"}`,
            `Butler candidate validation goal: ${candidateValidationGoal}`,
            `Butler candidate validation evidence:\n${candidateValidationEvidence}`,
            candidateValidation
              ? `Repeatable validation against sealed candidate: ${candidateValidationCommand} (exit ${candidateValidation.exitCode})`
              : "No command was required for Butler's candidate judgment.",
            candidateValidation?.stdout ? `Repeatable validation output:\n${candidateValidation.stdout}` : "",
            localOperationalVerification
              ? `Local operational command against sealed candidate: ${localOperationalCommand} (exit ${localOperationalVerification.exitCode})`
              : "Local operational exercise deferred to Worker because Butler did not have a meaningful environment-independent check.",
            localOperationalVerification?.stdout ? `Local operational output:\n${localOperationalVerification.stdout}` : "",
            `Worker operational verification goal: ${workerVerificationGoal}`,
            `Worker runtime requirements:\n${runtimeRequirements.length ? runtimeRequirements.map((item) => `- ${item}`).join("\n") : "- none identified"}`
          ].filter(Boolean).join("\n"));
          proposal = await access.skillsService.proposeButlerPreparedInstall(access.runtimeThreadId, {
            name,
            source: redactSensitiveText(text(params.source)),
            candidatePath,
            candidateArchiveBase64: sealed.archiveBase64,
            evidence,
            workerVerificationGoal,
            runtimeRequirements
          });
        } finally {
          await sealed.cleanup();
        }
        const { message } = await presentProposal(proposal);
        return {
          content: [{ type: "text", text: `Prepared skill ${proposal.id} is awaiting operator approval for the shared registry. End this turn now. Do not call apply_skill_change or another question tool. The operator's decision will arrive in a new turn; apply only after that turn explicitly carries the approval.` }],
          details: { proposal, candidateValidation, localOperationalVerification, question: message.question }
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
          content: [{ type: "text", text: `Skill change proposal ${proposal.id} is awaiting operator approval. End this turn now. Do not call apply_skill_change or another question tool. The operator's decision will arrive in a new turn.` }],
          details: { proposal, question: message.question }
        };
      }
    }),
    access.defineButlerTool({
      name: "confirm_worker_skill_operability",
      label: "Confirm Worker skill operability",
      description: "Mark a published shared skill ready only after Butler judges that its bound fresh Worker report proves the verification goal.",
      promptSnippet: "confirm_worker_skill_operability: use only for the fresh verification job started by apply_skill_change, after reviewing the latest completed Worker report and deciding its evidence proves the assigned goal. Judge evidence according to the skill's actual shape and intended outcome; do not require a command, file, binary, or other proof form unless that capability calls for it. This posts the final ready result to the operator.",
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
        const ready = access.skillsService.confirmAgentResultVerification(access.runtimeThreadId, resultId, threadId);
        await access.postOperatorJobReply(threadId, `Installed skill ${ready.skill.name} is ready. Butler reviewed the fresh Worker's evidence and accepted it against the verification goal.`);
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
      promptSnippet: "apply_skill_change: call this only in the new turn that carries the operator's answer approving the matching proposal card. Never call it in the turn that created the card. The server rejects unapproved, rejected, expired, cross-session, or stale proposals. If publication succeeded but Worker verification could not start, resume the missing proof without reinstalling: retry the same proposal id while its approval record is available, or inspect the installed skill and delegate its verification goal directly after a Manor restart.",
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
              const requirementText = result.verification.runtimeRequirements.length
                ? ` Runtime facts and requirements to account for: ${result.verification.runtimeRequirements.join("; ")}.`
                : "";
              const instruction = `Fresh-session confirmation for shared skill ${result.skill.name}, change result ${result.id}. Load ${result.verification.invocation} and pursue this goal using Worker judgment: ${result.verification.goal ?? "prove the installed capability works for its intended purpose"}.${requirementText} Do not modify the shared registry. Use the skill in a representative way and submit a completed Manor report only when the goal is genuinely proven; otherwise report the concrete blocker. Choose evidence appropriate to the capability, such as observed behavior, a command result, an API response, a produced artifact, or a well-supported advisory outcome. Do not invent a command or file requirement for a skill that has another shape.`;
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
              throw new Error(`Published ${result.skill.name}, but fresh Worker verification could not start. The skill remains installed and verification-pending. Resume verification without reinstalling: retry apply_skill_change with the same proposal id after the Worker runtime is available, or delegate the installed skill's verification goal directly if Manor has restarted. ${error instanceof Error ? error.message : String(error)}`);
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
