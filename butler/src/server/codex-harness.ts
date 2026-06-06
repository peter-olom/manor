import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { handleHarnessArtifactPolicyAction } from "./codex-harness-artifact-policy.js";
import {
  type BrokerAccessRegistryPayload,
  type HarnessCapability,
  type HarnessRegistryPayload,
  normalizeString,
  looksLikeHarnessLookupFailure,
  normalizeEnv,
  normalizeHeartbeatKind,
  normalizePositiveInteger,
  normalizeStringArray
} from "./codex-harness-helpers.js";
import { formatHarnessExecutionContract, formatHarnessRuntimeModel } from "./codex-harness-format.js";
import { handleHarnessDesktopAction } from "./codex-harness-desktop.js";
import { formatHarnessJobMemory, formatHarnessProjectMemory, handleHarnessMemoryAction } from "./codex-harness-memory.js";
import { handleHarnessProofAction } from "./codex-harness-proof.js";
import { CodexExecMemoryReviewService } from "./memory-review.js";
import {
  reconcileHarnessThreadPreviews,
  reconcileHarnessThreadServices,
  reconcileHarnessThreadStacks,
  removeHarnessStackArtifacts,
  resolveHarnessThreadPreview,
  resolveHarnessThreadService,
  resolveHarnessThreadStack
} from "./codex-harness-runtime.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import { hasVisualProof, threadRequiresVisualProof } from "./proof-policy.js";
import {
  applyServiceStartedPolicies,
  formatProjectPolicyContextLines
} from "./project-artifacts-policies.js";
import { resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { ButlerStateStore } from "./state-store.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import {
  applyWorkspacePreviewDefaults,
  formatWorkspaceBootstrapLines,
  inspectWorkspaceBootstrap
} from "./workspace-bootstrap.js";
import type { CodexThreadRecord, PreviewLeaseView, PreviewVerificationView } from "./types.js";

function mentionsNativeDesktopTarget(thread: CodexThreadRecord): boolean {
  const contract = thread.executionContract;
  const text = [
    thread.supervisor.summary,
    thread.supervisor.latestAgentReply,
    contract?.requestedTask,
    contract?.operatorGoal,
    ...(contract?.acceptancePoints ?? []),
    ...(contract?.notes ?? [])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return /\b(electron|native|desktop|headed|vnc|novnc)\b/.test(text);
}

export class CodexHarnessService {
  private readonly registryPath: string;
  private readonly brokerAccessPath: string;
  private readonly artifactsDir: string;
  private readonly store: ButlerStateStore;
  private readonly runtimeBroker: RuntimeBrokerClient;
  private readonly serviceTemplateRegistry: ServiceTemplateRegistry;
  private readonly memoryReview: CodexExecMemoryReviewService | null;
  private readonly capabilities = new Map<string, HarnessCapability>();

  constructor(options: {
    codexHomeDir: string;
    stateDir: string;
    artifactsDir: string;
    store: ButlerStateStore;
    runtimeBroker: RuntimeBrokerClient;
    serviceTemplateRegistry: ServiceTemplateRegistry;
    memoryReview?: CodexExecMemoryReviewService | null;
  }) {
    this.registryPath = path.join(options.codexHomeDir, "manor", "harness-capabilities.json");
    this.brokerAccessPath = path.join(options.stateDir, "codex-broker-access.json");
    this.artifactsDir = options.artifactsDir;
    this.store = options.store;
    this.runtimeBroker = options.runtimeBroker;
    this.serviceTemplateRegistry = options.serviceTemplateRegistry;
    this.memoryReview = options.memoryReview ?? null;
  }

  private getRuntimeAccess() {
    return {
      store: this.store,
      runtimeBroker: this.runtimeBroker,
      serviceTemplateRegistry: this.serviceTemplateRegistry
    };
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.mkdir(path.dirname(this.brokerAccessPath), { recursive: true });
    const raw = await fs.readFile(this.registryPath, "utf8").catch(() => "");
    if (!raw) {
      await this.save();
      return;
    }
    const parsed = JSON.parse(raw) as Partial<HarnessRegistryPayload>;
    const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : [];
    this.capabilities.clear();
    for (const entry of capabilities) {
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.token === "string" &&
        typeof entry.threadId === "string" &&
        typeof entry.cwd === "string"
      ) {
        this.capabilities.set(entry.threadId, {
          id: entry.id,
          token: entry.token,
          threadId: entry.threadId,
          cwd: entry.cwd,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
          updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now()
        });
      }
    }
  }

  private async save(): Promise<void> {
    const payload: HarnessRegistryPayload = { capabilities: [...this.capabilities.values()].sort((left, right) => left.createdAt - right.createdAt) };
    const brokerAccessPayload: BrokerAccessRegistryPayload = { grants: payload.capabilities.map((capability) => ({ token: capability.token, threadId: capability.threadId, createdAt: capability.createdAt, updatedAt: capability.updatedAt })) };
    await fs.writeFile(this.registryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.writeFile(this.brokerAccessPath, `${JSON.stringify(brokerAccessPayload, null, 2)}\n`, "utf8");
  }

  async ensureThreadCapability(threadId: string, cwd: string | null | undefined): Promise<HarnessCapability | null> {
    const normalizedCwd = normalizeString(cwd);
    if (!threadId || !normalizedCwd) return null;
    const now = Date.now();
    const existing = this.capabilities.get(threadId);
    const nextCapability: HarnessCapability = existing
      ? {
          ...existing,
          cwd: normalizedCwd,
          updatedAt: now
        }
      : {
          id: crypto.randomUUID(),
          token: crypto.randomBytes(24).toString("hex"),
          threadId,
          cwd: normalizedCwd,
          createdAt: now,
          updatedAt: now
        };

    this.capabilities.set(threadId, nextCapability);
    await this.save();
    await this.maybeAdoptWorkspaceStack(nextCapability).catch(() => null);
    return nextCapability;
  }

  async reconcileThreadCapabilities(): Promise<void> {
    const activeThreads = this.store
      .listThreads()
      .map((thread) => this.store.getThread(thread.id))
      .filter((thread): thread is NonNullable<ReturnType<ButlerStateStore["getThread"]>> => Boolean(thread));
    const activeThreadIds = new Set(activeThreads.map((thread) => thread.id));
    let changed = false;

    for (const threadId of [...this.capabilities.keys()]) {
      if (activeThreadIds.has(threadId)) {
        continue;
      }
      this.capabilities.delete(threadId);
      changed = true;
    }
    const now = Date.now();
    for (const thread of activeThreads) {
      const normalizedCwd = normalizeString(thread.cwd) || "/repos";
      const existing = this.capabilities.get(thread.id);
      if (existing) {
        if (existing.cwd !== normalizedCwd) {
          this.capabilities.set(thread.id, {
            ...existing,
            cwd: normalizedCwd,
            updatedAt: now
          });
          changed = true;
        }
        continue;
      }

      this.capabilities.set(thread.id, {
        id: crypto.randomUUID(),
        token: crypto.randomBytes(24).toString("hex"),
        threadId: thread.id,
        cwd: normalizedCwd,
        createdAt: now,
        updatedAt: now
      });
      changed = true;
    }

    if (changed) {
      await this.save();
    }
    for (const capability of this.capabilities.values()) {
      await this.maybeAdoptWorkspaceStack(capability).catch(() => null);
    }
  }

  async revokeThreadCapability(threadId: string): Promise<void> { if (this.capabilities.delete(threadId)) await this.save(); }

  private getCapabilityByToken(token: string): HarnessCapability | null {
    const normalized = normalizeString(token);
    if (!normalized) return null;
    for (const capability of this.capabilities.values()) {
      if (capability.token === normalized) return capability;
    }
    return null;
  }

  private requireCapability(token: string): HarnessCapability {
    const capability = this.getCapabilityByToken(token);
    if (!capability) throw new Error("Invalid Codex harness token");
    const thread = this.store.getThread(capability.threadId);
    if (!thread) throw new Error("Codex harness capability references an unknown thread");
    return capability;
  }

  private getThreadContext(capability: HarnessCapability) {
    const thread = this.store.getThread(capability.threadId);
    if (!thread) throw new Error("Codex thread is no longer available");
    return thread;
  }
  private listThreadProofs(threadId: string) { return this.store.listPreviewProofs().filter((proof) => proof.threadId === threadId); }
  private formatProofSignal(verification: Pick<PreviewVerificationView, "failureKind" | "status">): string {
    const statusPart = verification.status ? ` status=${verification.status}` : "";
    return verification.failureKind === "none" ? `signal=none${statusPart}` : `signal=${verification.failureKind}${statusPart}`;
  }
  private formatPreviewVisibility(threadId: string, lease: PreviewLeaseView): string {
    const proofs = this.listThreadProofs(threadId).filter((proof) => proof.previewId === lease.id).slice(0, 2);
    const verification = lease.lastVerification;
    const verificationLine = verification
      ? `lastProof=${verification.runId} ${this.formatProofSignal(verification)} url=${verification.url}`
      : "lastProof=none";
    const heartbeatLine = `heartbeat=${lease.bootstrap.heartbeatKind}${lease.bootstrap.heartbeatTarget ? ` ${lease.bootstrap.heartbeatTarget}` : ""}${lease.bootstrap.lastHeartbeatError ? ` err=${lease.bootstrap.lastHeartbeatError}` : ""}`;
    const proofLine =
      proofs.length === 0
        ? "proofs=none"
        : `proofs=${proofs.map((proof) => `${proof.verification.runId}@${new Date(proof.verification.checkedAt).toISOString()}`).join(", ")}`;
    return `${lease.id} | ${lease.title} | ${lease.status}/${lease.bootstrap.phase} | route=${lease.operatorUrl} | aliases=${lease.aliases.join(",") || "(none)"} | target=${lease.targetHost}:${lease.targetPort} | ${heartbeatLine} | ${verificationLine} | ${proofLine}`;
  }

  private async validateWorkerReport(
    capability: HarnessCapability,
    report: {
      status: "completed" | "blocked";
      summary: string;
      details?: string | null;
    }
  ): Promise<void> {
    const thread = this.getThreadContext(capability);
    const combined = [report.summary, report.details].filter(Boolean).join("\n");
    const threadProofs = this.listThreadProofs(capability.threadId);
    if (report.status === "completed") {
      if (thread.executionContract?.proofExpectation === "requested" && threadProofs.length === 0) {
        throw new Error(
          "This job asked for proof. Gather persisted proof before reporting completed."
        );
      }
      if (threadRequiresVisualProof(thread) && !hasVisualProof(threadProofs)) {
        throw new Error(
          "This job affects operator-visible UI. Capture persisted screenshot or video proof before reporting completed; text or file proof alone is insufficient."
        );
      }
      return;
    }
    if (!report.details?.trim()) {
      throw new Error("Blocked reports require details that document what failed, what was tried, and the next sensible action.");
    }
    if (looksLikeHarnessLookupFailure(combined)) {
      throw new Error(
        `This job already has a Manor harness binding. Retry from ${capability.cwd} or use manor-harness --thread ${capability.threadId} instead of reporting the job blocked.`
      );
    }
  }

  private requireThreadPreview(capability: HarnessCapability, leaseId: string) {
    const lease = this.store.getPreviewLease(leaseId);
    if (!lease || lease.threadId !== capability.threadId) {
      throw new Error(`Preview ${leaseId} is not attached to this job`);
    }
    return lease;
  }

  private requireThreadPreviewReady(capability: HarnessCapability, leaseId: string) {
    const lease = this.requireThreadPreview(capability, leaseId);
    if (lease.status === "stopping") {
      throw new Error(`Preview ${leaseId} is stopping. Retry in a moment.`);
    }
    if (lease.status === "starting") {
      throw new Error(`Preview ${leaseId} is still starting. Retry in a moment.`);
    }
    return lease;
  }

  private requireThreadService(capability: HarnessCapability, serviceId: string) {
    const lease = this.store.getServiceLease(serviceId);
    if (!lease || lease.threadId !== capability.threadId) {
      throw new Error(`Service ${serviceId} is not attached to this job`);
    }
    return lease;
  }

  private resolveWorkspaceProject(
    cwd: string | null | undefined,
    thread: ReturnType<CodexHarnessService["getThreadContext"]>
  ) {
    const project = resolveWorkspaceProjectInfo(cwd || thread.cwd);
    if (project.id === "unknown") {
      return {
        id: thread.supervisor.projectId,
        label: thread.supervisor.projectLabel
      };
    }

    return project;
  }

  private async resolveThreadStack(capability: HarnessCapability, stackSelector: string) {
    return resolveHarnessThreadStack(this.getRuntimeAccess(), capability.threadId, stackSelector);
  }

  private async resolveThreadPreview(capability: HarnessCapability, previewSelector: string) {
    return resolveHarnessThreadPreview(this.getRuntimeAccess(), capability.threadId, previewSelector);
  }

  private async resolveThreadService(capability: HarnessCapability, serviceSelector: string) {
    return resolveHarnessThreadService(this.getRuntimeAccess(), capability.threadId, serviceSelector);
  }

  private async maybeAdoptWorkspaceStack(capability: HarnessCapability) {
    const attachedStacks = await this.runtimeBroker.listStacks(capability.threadId);
    for (const stack of attachedStacks) {
      this.store.upsertStackLease(stack);
    }
    if (attachedStacks.length > 0) {
      return null;
    }

    const candidates = (await this.runtimeBroker.listStacks()).filter(
      (stack) => !stack.threadId && normalizeString(stack.worktreePath) === capability.cwd
    );
    if (candidates.length !== 1) {
      return null;
    }

    const adopted = await this.runtimeBroker.adoptStack({
      stackId: candidates[0].id,
      threadId: capability.threadId
    });
    this.store.upsertStackLease(adopted);
    this.store.addEvent(capability.threadId, "harness/stack/adopt", `Adopted stack ${adopted.id}`);
    return adopted;
  }

  private getServiceTemplate(templateId: string): LoadedServiceTemplate {
    const template = this.serviceTemplateRegistry.get(templateId);
    if (!template) {
      throw new Error(`Unknown service template: ${templateId}`);
    }
    return template;
  }

  private listServiceTemplates(): LoadedServiceTemplate[] {
    return this.serviceTemplateRegistry.list();
  }

  private removeStackArtifacts(stackId: string) {
    removeHarnessStackArtifacts(this.store, stackId);
  }

  private async reconcileThreadPreviews(threadId: string) {
    return reconcileHarnessThreadPreviews(this.getRuntimeAccess(), threadId);
  }

  private async reconcileThreadStacks(threadId: string) {
    return reconcileHarnessThreadStacks(this.getRuntimeAccess(), threadId);
  }

  private async reconcileThreadServices(threadId: string) {
    return reconcileHarnessThreadServices(this.getRuntimeAccess(), threadId);
  }

  private describeCapability(capability: HarnessCapability): string {
    const thread = this.getThreadContext(capability);
    const project = this.resolveWorkspaceProject(capability.cwd, thread);
    const stacks = this.store.listStackLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const previews = this.store.listPreviewLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const services = this.store.listServiceLeases().filter((lease) => lease.threadId === capability.threadId && lease.status !== "stopped");
    const proofs = this.listThreadProofs(capability.threadId).slice(0, 3);

    const stackLines =
      stacks.length === 0
        ? "Stacks: none"
        : `Stacks:\n${stacks.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | network=${lease.networkName} | ${formatStackStorageSummary(lease)} | previews=${lease.previewIds.length} | services=${lease.serviceIds.length}`).join("\n")}`;
    const previewLines =
      previews.length === 0
        ? "Previews: none"
        : `Previews:\n${previews.map((lease, index) => `${index + 1}. ${this.formatPreviewVisibility(capability.threadId, lease)}`).join("\n")}`;
    const serviceLines =
      services.length === 0
        ? "Services: none"
        : `Services:\n${services.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.connection.uri ?? `${lease.connection.host}:${lease.connection.port}`}`).join("\n")}`;
    const proofLines =
      proofs.length === 0
        ? "Proof bundles: none"
        : `Proof bundles:\n${proofs
            .map(
              (proof, index) =>
                `${index + 1}. ${proof.verification.runId} | preview=${proof.previewTitle} | ${this.formatProofSignal(proof.verification)} | url=${proof.verification.url}`
            )
            .join("\n")}`;

    return [
      `Job ${thread.id}`,
      `Workspace: ${capability.cwd}`,
      `Project: ${project.label}`,
      `Summary: ${thread.supervisor.summary}`,
      ...formatHarnessExecutionContract(thread),
      ...formatHarnessJobMemory(this.store, capability.threadId),
      ...formatHarnessProjectMemory(this.store, project.id),
      ...formatProjectPolicyContextLines({ store: this.store, projectId: project.id }),
      ...formatHarnessRuntimeModel(),
      stackLines,
      previewLines,
      serviceLines,
      proofLines,
      `Service templates: ${this.listServiceTemplates().map((template) => template.id).join(", ")}`
    ].join("\n");
  }

  async handleAction(input: {
    token: string;
    action: string;
    params?: Record<string, unknown>;
  }): Promise<{ text: string; data?: Record<string, unknown> }> {
    const capability = this.requireCapability(input.token);
    const action = normalizeString(input.action);
    const params = input.params ?? {};
    const thread = this.getThreadContext(capability);
    if (action === "context" || action.startsWith("stack.") || action.startsWith("preview.") || action.startsWith("service.") || action.startsWith("assist.")) {
      await this.maybeAdoptWorkspaceStack(capability);
    }
    if (action === "context") {
      const project = this.resolveWorkspaceProject(capability.cwd, thread);
      const stacks = await this.reconcileThreadStacks(capability.threadId);
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      const services = await this.reconcileThreadServices(capability.threadId);
      const proofs = this.listThreadProofs(capability.threadId);
      const workspaceBootstrap = await inspectWorkspaceBootstrap(capability.cwd);
      return {
        text: [
          `Job ${thread.id}`,
          `Workspace: ${capability.cwd}`,
          `Harness binding: manor-harness --thread ${thread.id}`,
          `Project: ${project.label}`,
          `Summary: ${thread.supervisor.summary}`,
          ...formatHarnessExecutionContract(thread),
          ...formatHarnessJobMemory(this.store, capability.threadId),
          ...formatHarnessProjectMemory(this.store, project.id),
          ...formatProjectPolicyContextLines({ store: this.store, projectId: project.id }),
          ...formatHarnessRuntimeModel(),
          stacks.length === 0
            ? "Stacks: none"
            : `Stacks:\n${stacks.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | network=${lease.networkName} | ${formatStackStorageSummary(lease)} | previews=${lease.previewIds.length} | services=${lease.serviceIds.length}`).join("\n")}`,
          previews.length === 0
            ? "Previews: none"
            : `Previews:\n${previews.map((lease, index) => `${index + 1}. ${this.formatPreviewVisibility(capability.threadId, lease)}`).join("\n")}`,
          services.length === 0
            ? "Services: none"
            : `Services:\n${services.map((lease, index) => `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status} | ${lease.connection.uri ?? `${lease.connection.host}:${lease.connection.port}`}`).join("\n")}`,
          proofs.length === 0
            ? "Proof bundles: none"
            : `Proof bundles:\n${proofs.map((proof, index) => `${index + 1}. ${proof.verification.runId} | preview=${proof.previewTitle} | ${this.formatProofSignal(proof.verification)} | url=${proof.verification.url}`).join("\n")}`,
          `Service templates: ${this.listServiceTemplates().map((template) => template.id).join(", ")}`,
          ...formatWorkspaceBootstrapLines(workspaceBootstrap)
        ].join("\n"),
        data: {
          threadId: thread.id,
          cwd: capability.cwd,
          harnessBinding: `manor-harness --thread ${thread.id}`,
          jobMemory: this.store.getJobMemory(thread.id),
          projectMemory: this.store.getProjectMemory(project.id),
          pendingPromotionCandidates: this.store.listPendingPromotionCandidates(project.id),
          stacks,
          previews,
          services,
          proofs,
          serviceTemplates: this.listServiceTemplates(),
          workspaceBootstrap,
          executionContract: thread.executionContract
        }
      };
    }
    const proofResult = await handleHarnessProofAction({
      action,
      params,
      capability,
      thread,
      store: this.store,
      artifactsDir: this.artifactsDir,
      resolveWorkspaceProject: () => this.resolveWorkspaceProject(capability.cwd, thread)
    });
    if (proofResult) return proofResult;
    if (action === "report") {
      const status = normalizeString(params.status);
      const summary = normalizeString(params.summary);
      const details = normalizeString(params.details) || null;
      const turnId = normalizeString(params.turnId) || null;

      if ((status !== "completed" && status !== "blocked") || !summary) {
        throw new Error("report requires status=completed|blocked and a non-empty summary");
      }

      await this.validateWorkerReport(capability, {
        status,
        summary,
        details
      });

      const report = this.store.recordWorkerReport(capability.threadId, {
        status,
        summary,
        details,
        turnId
      });
      this.store.addEvent(capability.threadId, `harness/report/${status}`, summary);
      this.memoryReview?.reviewWorkerReportAsync(report);
      return {
        text: `Recorded ${status} supervisor report for job ${capability.threadId}.`,
        data: { report }
      };
    }
    const memoryAction = handleHarnessMemoryAction({
      action,
      threadId: capability.threadId,
      projectId: this.resolveWorkspaceProject(capability.cwd, thread).id,
      store: this.store,
      params
    });
    if (memoryAction) {
      return memoryAction;
    }
    const artifactOrPolicyAction = await handleHarnessArtifactPolicyAction({
      action,
      threadId: capability.threadId,
      cwd: capability.cwd,
      artifactsDir: this.artifactsDir,
      thread,
      store: this.store,
      runtimeBroker: this.runtimeBroker,
      params,
      resolveWorkspaceProject: (workspaceCwd, targetThread) => this.resolveWorkspaceProject(workspaceCwd, targetThread)
    });
    if (artifactOrPolicyAction) {
      return artifactOrPolicyAction;
    }
    if (action === "assist.request") {
      const summary = normalizeString(params.summary);
      const details = normalizeString(params.details) || null;
      const question = normalizeString(params.question) || null;
      if (!summary) {
        throw new Error("assist.request requires a non-empty summary");
      }
      const workspaceBootstrap = await inspectWorkspaceBootstrap(capability.cwd);
      const stacks = await this.reconcileThreadStacks(capability.threadId);
      const activeStack = stacks.find((stack) => stack.status !== "stopped") ?? null;
      const previewDefaults = applyWorkspacePreviewDefaults(
        {
          image: undefined,
          egressProfile: "internet",
          egressDomains: [],
          bootstrapHint: undefined
        },
        workspaceBootstrap
      );
      const responseLines = ["Butler guidance for this job:"];
      responseLines.push(`Thread-bound harness command: manor-harness --thread ${capability.threadId} ...`);
      responseLines.push(...formatHarnessExecutionContract(thread));
      responseLines.push(...formatHarnessRuntimeModel());
      responseLines.push(...formatWorkspaceBootstrapLines(workspaceBootstrap));
      responseLines.push(`If you drift out of ${capability.cwd}, keep using the thread-bound harness command instead of concluding Manor is unavailable.`);
      if (activeStack) {
        responseLines.push(`Use the existing stack ${activeStack.id} for the preview unless you have a reason to split the runtime.`);
      }
      responseLines.push("Previews now default to normal outbound internet access. Use an explicit egress mode only when you need to block or restrict outbound traffic.");
      responseLines.push("Use Codex-shell for repo work. Move into Manor runtime only when you actually need it.");
      if (previewDefaults.bootstrapHint) {
        responseLines.push(`Preview bootstrap hint: ${previewDefaults.bootstrapHint}.`);
      }
      responseLines.push("Previews use isolated disposable workspaces so smoke checks do not modify the source workspace.");
      if (workspaceBootstrap?.suggestedPreview?.suggestedInstallCommand) {
        responseLines.push(`Suggested install step inside the preview: ${workspaceBootstrap.suggestedPreview.suggestedInstallCommand}.`);
      }
      responseLines.push("Do not hunt for Manor-specific bootstrap magic. If the project needs a command, choose it and run it explicitly.");
      if (thread.executionContract?.proofExpectation === "requested") {
        responseLines.push(
          mentionsNativeDesktopTarget(thread)
            ? "This job asked for native headed proof. Use desktop status/start/action/stop so the app appears in the noVNC-visible desktop."
            : "This job asked for proof. Browser-use sessions are the simplest way to capture durable browser artifacts."
        );
      }
      if (threadRequiresVisualProof(thread)) {
        responseLines.push(
          "This job has UI implications. Persist and surface screenshot or video proof of the relevant UI state; text logs or TXT/file proof alone are not enough."
        );
      }
      responseLines.push("Do not use `corepack enable` in Codex-shell for preview-oriented runtime setup. If repo-local instructions explicitly require a root-level install step, follow the repo guidance instead.");
      responseLines.push("Only report the job blocked when you can say what you tried and why the next sensible step still cannot proceed.");
      if (question) {
        responseLines.push(`Requested help: ${question}`);
      }
      if (details) {
        responseLines.push(`Worker details: ${details}`);
      }
      this.store.addEvent(capability.threadId, "harness/assist/request", summary);
      return {
        text: responseLines.join("\n"),
        data: {
          summary,
          details,
          question,
          workspaceBootstrap,
          stackId: activeStack?.id ?? null,
          previewDefaults
        }
      };
    }
    if (action === "preview.list") {
      const previews = await this.reconcileThreadPreviews(capability.threadId);
      return {
        text:
          previews.length === 0
            ? "No previews are attached to this job."
            : previews
                .map(
                  (lease, index) =>
                    `${index + 1}. ${lease.id} | ${lease.title} | ${lease.status}/${lease.bootstrap.phase} | ${lease.operatorUrl}`
                )
                .join("\n"),
        data: { previews }
      };
    }
    if (action === "stack.list") {
      const stacks = await this.reconcileThreadStacks(capability.threadId);
      return {
        text:
          stacks.length === 0
            ? "No stacks are attached to this job."
            : stacks
                .map(
                  (stack, index) =>
                    `${index + 1}. ${stack.id} | ${stack.title} | ${stack.status} | network=${stack.networkName} | ${formatStackStorageSummary(stack)} | previews=${stack.previewIds.length} | services=${stack.serviceIds.length}`
                )
                .join("\n"),
        data: { stacks }
      };
    }
    if (action === "stack.start" || action === "stack.start_stateful") {
      const title = normalizeString(params.title) || `${thread.supervisor.projectLabel} stack`;
      const cwd = normalizeString(params.cwd) || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const requestedStorageMode =
        action === "stack.start_stateful"
          ? normalizeStackStorageMode(params.storageMode) || "job"
          : normalizeStackStorageMode(params.storageMode);
      const retainsVolumes = params.retainsVolumes === true;
      const storageKey = normalizeString(params.storageKey) || null;
      const cloneFromStorageKey = normalizeString(params.cloneFromStorageKey) || null;
      const stack = await this.runtimeBroker.createStack({
        stackId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        worktreePath: cwd,
        storageMode: requestedStorageMode,
        retainsVolumes,
        storageKey,
        cloneFromStorageKey
      });
      this.store.upsertStackLease(stack);
      this.store.addEvent(capability.threadId, "harness/stack/start", `Started stack ${stack.id}`);
      return {
        text: `Started stack ${stack.title}. Network=${stack.networkName}. ${formatStackStorageSummary(stack)}.`,
        data: { stack }
      };
    }

    if (action === "stack.inspect") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const inspected = await this.runtimeBroker.inspectStack(stack.id);
      this.store.upsertStackLease(inspected);
      this.store.noteStackLeaseActivity(inspected.id);
      return {
        text: `${inspected.title} is ${inspected.status}. Network=${inspected.networkName}. ${formatStackStorageSummary(inspected)}. Previews=${inspected.previewIds.length}. Services=${inspected.serviceIds.length}.`,
        data: { stack: inspected }
      };
    }
    if (action === "stack.promote") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const targetStorageKey = normalizeString(params.targetStorageKey) || null;
      const promotion = await this.runtimeBroker.promoteStack({
        stackId: stack.id,
        targetStorageKey
      });
      const inspected = await this.runtimeBroker.inspectStack(stack.id);
      this.store.upsertStackLease(inspected);
      this.store.noteStackLeaseActivity(inspected.id);
      this.store.addEvent(
        capability.threadId,
        "harness/stack/promote",
        `Promoted stack ${inspected.id} to ${promotion.targetStorageKey}`
      );
      return {
        text: `Promoted ${promotion.promotedVolumes.length} volumes from ${promotion.sourceStorageKey} to ${promotion.targetStorageKey}.`,
        data: { promotion, stack: inspected }
      };
    }
    if (action === "stack.stop") {
      const stack = await this.resolveThreadStack(capability, normalizeString(params.stackId));
      const dropVolumes = params.dropVolumes !== false;
      await this.runtimeBroker.stopStack(stack.id, { dropVolumes });
      this.removeStackArtifacts(stack.id);
      this.store.addEvent(capability.threadId, "harness/stack/stop", `Stopped stack ${stack.id}`);
      return {
        text: `Stopped stack ${stack.id}.${dropVolumes ? " Dropped retained volumes." : ""}`,
        data: { stackId: stack.id, dropVolumes }
      };
    }
    if (action === "preview.start") {
      const title = normalizeString(params.title) || `${thread.supervisor.projectLabel} preview`;
      const command = normalizeString(params.command);
      const stackSelector = normalizeString(params.stackId) || null;
      const stack = stackSelector ? await this.resolveThreadStack(capability, stackSelector) : null;
      const cwd = normalizeString(params.cwd) || stack?.worktreePath || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const aliases = normalizeStringArray(params.aliases);
      const env = normalizeEnv(params.env);
      const port = typeof params.port === "number" ? params.port : Number(params.port ?? 0);
      const workspaceBootstrap = await inspectWorkspaceBootstrap(cwd);
      const previewDefaults = applyWorkspacePreviewDefaults(
        {
          image: normalizeString(params.image) || undefined,
          egressProfile: normalizeString(params.egressProfile) || "internet",
          egressDomains: normalizeStringArray(params.egressDomains),
          bootstrapHint: normalizeString(params.bootstrapHint) || undefined
        },
        workspaceBootstrap
      );
      const image = previewDefaults.image;
      const egressProfile = previewDefaults.egressProfile || "internet";
      const egressDomains = previewDefaults.egressDomains ?? [];
      const bootstrapWaitSeconds = normalizePositiveInteger(params.bootstrapWaitSeconds) ?? undefined;
      const bootstrapHint = previewDefaults.bootstrapHint;
      const heartbeatKind = normalizeHeartbeatKind(params.heartbeatKind) ?? undefined;
      const heartbeatTarget = normalizeString(params.heartbeatTarget) || undefined;
      const heartbeatIntervalSeconds = normalizePositiveInteger(params.heartbeatIntervalSeconds) ?? undefined;
      const workspaceMode = "snapshot";

      if (!command || !Number.isFinite(port) || port <= 0) {
        throw new Error("preview.start requires command and port");
      }

      const lease = await this.runtimeBroker.createLease({
        leaseId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        stackId: stack?.id ?? null,
        aliases,
        worktreePath: cwd,
        branchName: null,
        targetPort: port,
        command,
        workspaceMode,
        image,
        egressProfile,
        egressDomains,
        bootstrapWaitSeconds,
        bootstrapHint,
        heartbeatKind,
        heartbeatTarget,
        heartbeatIntervalSeconds,
        env
      });
      this.store.upsertPreviewLease(lease);
      this.store.addEvent(capability.threadId, "harness/preview/start", `Started preview ${lease.id}`);
      return {
        text: `Started preview ${lease.title} at ${lease.operatorUrl}. Workspace=${lease.workspaceMode}.${previewDefaults.autofilled.length > 0 ? ` Auto-filled ${previewDefaults.autofilled.join(", ")} from workspace bootstrap.` : ""}`,
        data: { lease, workspaceBootstrap, previewDefaults }
      };
    }
    if (action === "preview.inspect") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const inspected = await this.runtimeBroker.inspectLease(preview.id);
      this.store.upsertPreviewLease(inspected);
      this.store.notePreviewLeaseActivity(inspected.id);
      const lease = this.store.getPreviewLease(inspected.id) ?? preview;
      const proofs = this.listThreadProofs(capability.threadId).filter((proof) => proof.previewId === lease.id).slice(0, 3);
      return {
        text: [
          `${lease.title} is ${inspected.runtime.status}. Bootstrap=${lease.bootstrap.phase}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}.`,
          `Workspace mode: ${lease.workspaceMode}`,
          `Aliases: ${lease.aliases.join(", ") || "(none)"}`,
          `Target: ${lease.targetHost}:${lease.targetPort}`,
          `Heartbeat: ${lease.bootstrap.heartbeatKind}${lease.bootstrap.heartbeatTarget ? ` ${lease.bootstrap.heartbeatTarget}` : ""}`,
          lease.bootstrap.lastHeartbeatError ? `Last heartbeat error: ${lease.bootstrap.lastHeartbeatError}` : "",
          lease.lastVerification
            ? `Last proof: run=${lease.lastVerification.runId} ${this.formatProofSignal(lease.lastVerification)} url=${lease.lastVerification.url}`
            : "Last proof: none",
          proofs.length > 0
            ? `Archived proofs:\n${proofs.map((proof, index) => `${index + 1}. ${proof.verification.runId} | ${this.formatProofSignal(proof.verification)} | url=${proof.verification.url}`).join("\n")}`
            : "Archived proofs: none"
        ]
          .filter(Boolean)
          .join("\n"),
        data: { lease, proofs }
      };
    }

    if (action === "preview.processes") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      this.requireThreadPreviewReady(capability, preview.id);
      const result = await this.runtimeBroker.listProcesses(preview.id);
      this.store.notePreviewLeaseActivity(preview.id);
      const rows =
        result.processes.length === 0
          ? "No processes were reported."
          : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
      return {
        text: rows,
        data: { processes: result }
      };
    }

    if (action === "preview.logs") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      this.requireThreadPreviewReady(capability, preview.id);
      const result = await this.runtimeBroker.readLogs(preview.id, Number.isFinite(tail) ? tail : 200);
      this.store.notePreviewLeaseActivity(preview.id);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "preview.exec") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const command = normalizeString(params.command);
      const commandArgs = normalizeStringArray(params.commandArgs);
      const cwd = normalizeString(params.cwd) || undefined;
      const stdin = typeof params.stdin === "string" ? params.stdin : undefined;
      const stdinProvided = params.stdinProvided === true;
      this.requireThreadPreviewReady(capability, preview.id);
      if (!command && commandArgs.length === 0) {
        throw new Error("preview.exec requires command");
      }

      const result = await this.runtimeBroker.execInLease({
        leaseId: preview.id,
        command,
        commandArgs,
        cwd,
        stdin,
        stdinProvided
      });
      this.store.notePreviewLeaseActivity(preview.id);
      const body = [
        `exitCode=${result.exitCode ?? "unknown"}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        text: body || "Command completed with no output.",
        data: { result }
      };
    }

    if (action === "browser.use.start_preview") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const mode = normalizeString(params.mode) === "headful" ? "headful" : "headless";
      const targetPath = normalizeString(params.path) || undefined;
      const targetUrl = normalizeString(params.targetUrl) || undefined;
      const resolution = normalizeString(params.resolution) || undefined;
      const waitForSelector = normalizeString(params.waitForSelector) || undefined;
      const postLoadWaitMs = normalizePositiveInteger(params.postLoadWaitMs) ?? undefined;
      const headers = normalizeEnv(params.headers);
      const cookies = normalizeEnv(params.cookies);
      const sessionCookie = normalizeString(params.sessionCookie);
      if (preview.status === "stopped") {
        throw new Error(`Preview ${preview.id} is stopped. Start it first.`);
      }
      this.store.notePreviewLeaseActivity(preview.id);
      const session = await this.runtimeBroker.startPreviewBrowserSession({
        leaseId: preview.id,
        mode,
        path: targetPath,
        targetUrl,
        resolution,
        waitForSelector,
        postLoadWaitMs,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        cookies:
          Object.keys(cookies).length > 0
            ? Object.entries(cookies).map(([name, value]) => ({ name, value }))
            : undefined,
        sessionCookie: sessionCookie || undefined
      });
      return {
        text: `Browser-use session started for preview ${preview.id}. Session=${session.sessionId}. URL=${session.url}`,
        data: { session, preview }
      };
    }

    if (action === "browser.use.start_url") {
      const mode = normalizeString(params.mode) === "headful" ? "headful" : "headless";
      const targetUrl = normalizeString(params.targetUrl);
      const title = normalizeString(params.title) || targetUrl || "Browser use session";
      const resolution = normalizeString(params.resolution) || undefined;
      const waitForSelector = normalizeString(params.waitForSelector) || undefined;
      const postLoadWaitMs = normalizePositiveInteger(params.postLoadWaitMs) ?? undefined;
      const headers = normalizeEnv(params.headers);
      const cookies = normalizeEnv(params.cookies);
      const sessionCookie = normalizeString(params.sessionCookie);
      if (!targetUrl) {
        throw new Error("browser.use.start_url requires targetUrl");
      }

      const project = this.resolveWorkspaceProject(capability.cwd, thread);
      const session = await this.runtimeBroker.startBrowserSession({
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title,
        targetUrl,
        mode,
        resolution,
        waitForSelector,
        postLoadWaitMs,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        cookies:
          Object.keys(cookies).length > 0
            ? Object.entries(cookies).map(([name, value]) => ({ name, value }))
            : undefined,
        sessionCookie: sessionCookie || undefined
      });
      return {
        text: `Browser-use session started. Session=${session.sessionId}. URL=${session.url}`,
        data: { session }
      };
    }

    if (action === "browser.use.state") {
      const sessionId = normalizeString(params.sessionId);
      if (!sessionId) {
        throw new Error("browser.use.state requires sessionId");
      }
      const result = await this.runtimeBroker.inspectBrowserSession(sessionId);
      return {
        text: `Session ${result.session.sessionId} is active at ${result.session.url}. Actions=${result.session.actionCount}.`,
        data: { session: result.session }
      };
    }

    if (action === "browser.use.action") {
      const sessionId = normalizeString(params.sessionId);
      const actionType = normalizeString(params.actionType || params.type);
      if (!sessionId) {
        throw new Error("browser.use.action requires sessionId");
      }
      if (!actionType) {
        throw new Error("browser.use.action requires actionType");
      }

      const result = await this.runtimeBroker.runBrowserSessionAction(sessionId, {
        type: actionType,
        selector: normalizeString(params.selector) || undefined,
        value: normalizeString(params.value) || undefined,
        values: normalizeStringArray(params.values),
        text: normalizeString(params.text) || undefined,
        key: normalizeString(params.key) || undefined,
        url: normalizeString(params.url) || undefined,
        urlIncludes: normalizeString(params.urlIncludes) || undefined,
        script: typeof params.script === "string" ? params.script : undefined,
        ms: normalizePositiveInteger(params.ms) ?? undefined,
        x: typeof params.x === "number" && Number.isFinite(params.x) ? params.x : undefined,
        y: typeof params.y === "number" && Number.isFinite(params.y) ? params.y : undefined,
        delayMs: normalizePositiveInteger(params.delayMs) ?? undefined,
        timeoutMs: normalizePositiveInteger(params.timeoutMs) ?? undefined,
        label: normalizeString(params.label) || undefined,
        fileName: normalizeString(params.fileName) || undefined,
        autoCapture: params.autoCapture === false ? false : undefined
      });
      return {
        text: `Browser-use action ${result.action.type} completed. URL=${result.state.url}. Actions=${result.state.actionCount}.`,
        data: { result }
      };
    }

    if (action === "browser.use.stop") {
      const sessionId = normalizeString(params.sessionId);
      const reason = normalizeString(params.reason) || undefined;
      const previewLeaseId = normalizeString(params.leaseId) || null;
      if (!sessionId) {
        throw new Error("browser.use.stop requires sessionId");
      }

      const result = await this.runtimeBroker.stopBrowserSession(sessionId, reason);
      const verification = decoratePreviewVerification(result.verification);

      if (result.browserProof) {
        this.store.recordBrowserVerification({
          threadId: result.browserProof.threadId,
          projectId: result.browserProof.projectId,
          projectLabel: result.browserProof.projectLabel,
          title: result.browserProof.title,
          verification
        });
      } else {
        const effectivePreviewLeaseId =
          previewLeaseId || (result.tracked?.kind === "preview" ? result.tracked.leaseId : null);
        if (effectivePreviewLeaseId) {
          this.store.recordPreviewLeaseVerification(effectivePreviewLeaseId, verification);
          this.store.notePreviewLeaseActivity(effectivePreviewLeaseId);
        }
      }

      const remediationHint = verification.failureKind !== "none" ? verification.diagnostics?.remediationHints?.[0] ?? "" : "";
      const signalSummary =
        verification.failureKind === "none"
          ? `Signals=none${verification.status ? ` status=${verification.status}` : ""}.`
          : `Signals=${verification.failureKind}${verification.status ? ` status=${verification.status}` : ""}.${remediationHint ? ` Hint: ${remediationHint}` : ""}`;
      return {
        text: `Browser-use session stopped with proof run ${verification.runId}. ${signalSummary}`,
        data: { verification, browserProof: result.browserProof ?? null }
      };
    }

    const desktopResult = await handleHarnessDesktopAction({
      action,
      params,
      capability,
      thread,
      runtimeBroker: this.runtimeBroker,
      store: this.store,
      resolveWorkspaceProject: (cwd, targetThread) => this.resolveWorkspaceProject(cwd, targetThread)
    });
    if (desktopResult) {
      return desktopResult;
    }

    if (action === "preview.proof") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      const runId = normalizeString(params.runId) || null;
      const archivedProof = runId
        ? this.store
            .listPreviewProofs()
            .find((proof) => proof.previewId === preview.id && proof.verification.runId === runId) ?? null
        : this.store.getLatestPreviewProofForPreview(preview.id);
      const verification = archivedProof
        ? decoratePreviewVerification(archivedProof.verification)
        : preview.lastVerification
          ? decoratePreviewVerification(preview.lastVerification)
          : null;
      if (!verification) {
        throw new Error(`Preview ${preview.id} has no verification proof yet.`);
      }
      if (runId && verification.runId !== runId) {
        throw new Error(`Preview ${preview.id} does not have verification run ${runId}.`);
      }

      const artifactLines = await Promise.all(
        verification.artifacts.map(async (artifact) => {
          const exists =
            artifact.availability === "available" && artifact.filePath
              ? await fs
                  .stat(artifact.filePath)
                  .then(() => true)
                  .catch(() => false)
              : false;
          const availability = artifact.availability === "available" && exists ? "ready" : artifact.availability;
          return `${artifact.kind} | label=${artifact.label} | ${availability}`;
        })
      );

      this.store.notePreviewLeaseActivity(preview.id);
      return {
        text: [
          `Preview ${preview.id}`,
          `Verification run=${verification.runId} mode=${verification.mode} ${this.formatProofSignal(verification)}`,
          verification.phases.length > 0
            ? `Phases:\n${verification.phases.map((phase, index) => `${index + 1}. ${phase.label} | ${phase.status} | ${phase.durationMs}ms${phase.message ? ` | ${phase.message}` : ""}`).join("\n")}`
            : "Phases: none",
          `Readiness: routeOk=${verification.readiness.routeOk} selector=${verification.readiness.selector ?? "(none)"} selectorSatisfied=${verification.readiness.selectorSatisfied === null ? "n/a" : verification.readiness.selectorSatisfied} assetFailures=${verification.readiness.sameOriginAssetFailureCount} websocketFailures=${verification.readiness.websocketFailureCount} loginRedirect=${verification.readiness.loginRedirectDetected}`,
          artifactLines.length > 0 ? `Artifacts:\n${artifactLines.join("\n")}` : "Artifacts: none"
        ].join("\n"),
        data: {
          preview,
          verification
        }
      };
    }

    if (action === "browser.proof") {
      const runId = normalizeString(params.runId) || null;
      const browserProof =
        runId
          ? this.store
              .listPreviewProofs()
              .find(
                (proof) =>
                  proof.threadId === capability.threadId &&
                  proof.previewId === `browser:${capability.threadId}` &&
                  proof.verification.runId === runId
              ) ?? null
          : this.store
              .listPreviewProofs()
              .find(
                (proof) =>
                  proof.threadId === capability.threadId && proof.previewId === `browser:${capability.threadId}`
              ) ?? null;
      if (!browserProof) {
        throw new Error(`Thread ${capability.threadId} does not have a recorded browser proof yet.`);
      }
      const verification = decoratePreviewVerification(browserProof.verification);
      const artifactLines = await Promise.all(
        verification.artifacts.map(async (artifact) => {
          const exists =
            artifact.availability === "available" && artifact.filePath
              ? await fs
                  .stat(artifact.filePath)
                  .then(() => true)
                  .catch(() => false)
              : false;
          const availability = artifact.availability === "available" && exists ? "ready" : artifact.availability;
          return `${artifact.kind} | label=${artifact.label} | ${availability}`;
        })
      );

      return {
        text: [
          `Browser proof for thread ${capability.threadId}`,
          `Verification run=${verification.runId} mode=${verification.mode} ${this.formatProofSignal(verification)}`,
          verification.phases.length > 0
            ? `Phases:\n${verification.phases.map((phase, index) => `${index + 1}. ${phase.label} | ${phase.status} | ${phase.durationMs}ms${phase.message ? ` | ${phase.message}` : ""}`).join("\n")}`
            : "Phases: none",
          `Readiness: routeOk=${verification.readiness.routeOk} selector=${verification.readiness.selector ?? "(none)"} selectorSatisfied=${verification.readiness.selectorSatisfied === null ? "n/a" : verification.readiness.selectorSatisfied} assetFailures=${verification.readiness.sameOriginAssetFailureCount} websocketFailures=${verification.readiness.websocketFailureCount} loginRedirect=${verification.readiness.loginRedirectDetected}`,
          artifactLines.length > 0 ? `Artifacts:\n${artifactLines.join("\n")}` : "Artifacts: none"
        ].join("\n"),
        data: {
          verification
        }
      };
    }

    if (action === "preview.stop") {
      const preview = await this.resolveThreadPreview(capability, normalizeString(params.leaseId));
      this.requireThreadPreview(capability, preview.id);
      this.store.markPreviewLeaseStopping(preview.id);
      await this.runtimeBroker.stopLease(preview.id);
      this.store.removePreviewLease(preview.id);
      this.store.addEvent(capability.threadId, "harness/preview/stop", `Stopped preview ${preview.id}`);
      return {
        text: `Stopped preview ${preview.id}.`,
        data: { leaseId: preview.id }
      };
    }

    if (action === "service.templates") {
      const serviceTemplates = this.listServiceTemplates();
      return {
        text: serviceTemplates.map((template, index) => `${index + 1}. ${template.id} | ${template.label} | ${template.description}`).join("\n"),
        data: { serviceTemplates }
      };
    }

    if (action === "service.register_template") {
      const template = await this.serviceTemplateRegistry.upsert({
        id: normalizeString(params.id),
        label: normalizeString(params.label),
        description: normalizeString(params.description),
        runtimeKind: normalizeString(params.runtimeKind) === "embedded" ? "embedded" : "container",
        engine: normalizeString(params.engine),
        image: normalizeString(params.image) || undefined,
        port: typeof params.port === "number" ? params.port : Number(params.port),
        notes: normalizeString(params.notes) || undefined,
        command: normalizeString(params.command) || undefined,
        workingDir: normalizeString(params.workingDir) || undefined,
        envDefaults: normalizeEnv(params.envDefaults),
        fileName: normalizeString(params.fileName) || undefined,
        stackVolumePath: normalizeString(params.stackVolumePath) || undefined,
        connection:
          params.connection && typeof params.connection === "object"
            ? {
                databaseEnv: normalizeString((params.connection as Record<string, unknown>).databaseEnv) || undefined,
                databaseValue: normalizeString((params.connection as Record<string, unknown>).databaseValue) || undefined,
                usernameEnv: normalizeString((params.connection as Record<string, unknown>).usernameEnv) || undefined,
                usernameValue: normalizeString((params.connection as Record<string, unknown>).usernameValue) || undefined,
                passwordEnv: normalizeString((params.connection as Record<string, unknown>).passwordEnv) || undefined,
                passwordValue: normalizeString((params.connection as Record<string, unknown>).passwordValue) || undefined,
                uriTemplate: normalizeString((params.connection as Record<string, unknown>).uriTemplate) || undefined,
                notes: normalizeString((params.connection as Record<string, unknown>).notes) || undefined
              }
            : undefined
      });
      this.store.addEvent(capability.threadId, "harness/service/register-template", `Registered service template ${template.id}`);
      return {
        text: `Registered service template ${template.id}. Future jobs can reuse ${template.label}.`,
        data: { serviceTemplate: template }
      };
    }

    if (action === "service.list") {
      const services = await this.reconcileThreadServices(capability.threadId);
      return {
        text:
          services.length === 0
            ? "No services are attached to this job."
            : services
                .map(
                  (service, index) =>
                    `${index + 1}. ${service.id} | ${service.title} | ${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | ${service.connection.uri ?? `${service.connection.host}:${service.connection.port}`}`
                )
                .join("\n"),
        data: { services }
      };
    }

    if (action === "service.processes") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (service.runtimeKind !== "container") {
        this.store.noteServiceLeaseActivity(service.id);
        return {
          text: `${service.title} is embedded and does not expose container processes.`,
          data: { service }
        };
      }
      const result = await this.runtimeBroker.listServiceProcesses(service.id);
      this.store.noteServiceLeaseActivity(service.id);
      const rows =
        result.processes.length === 0
          ? "No processes were reported."
          : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
      return {
        text: rows,
        data: { processes: result }
      };
    }

    if (action === "service.start") {
      const templateId = normalizeString(params.templateId);
      const title = normalizeString(params.title);
      const stackSelector = normalizeString(params.stackId) || null;
      const stack = stackSelector ? await this.resolveThreadStack(capability, stackSelector) : null;
      const cwd = normalizeString(params.cwd) || stack?.worktreePath || capability.cwd;
      const project = this.resolveWorkspaceProject(cwd, thread);
      const aliases = normalizeStringArray(params.aliases);
      const env = normalizeEnv(params.env);
      const template = this.serviceTemplateRegistry.get(templateId);

      if (!template) {
        throw new Error(`Unknown service template: ${templateId}`);
      }

      const effectiveTitle = title || `${template.label} ${crypto.randomUUID().slice(0, 8)}`;

      if (template.runtimeKind === "embedded") {
        const filePath = `${cwd}/${template.fileName ?? ".manor/sqlite/app.db"}`.replace(/\/+/g, "/");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const lease = toServiceLeaseView({
          id: crypto.randomUUID(),
          threadId: capability.threadId,
          projectId: project.id,
          projectLabel: project.label,
          title: effectiveTitle,
          stackId: stack?.id ?? null,
          aliases,
          template,
          containerName: `embedded-${crypto.randomUUID().slice(0, 8)}`,
          targetHost: "localhost",
          targetPort: template.defaultPort,
          worktreePath: filePath,
          status: "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastError: null,
          env
        });
        this.store.upsertServiceLease(lease);
        this.store.noteServiceLeaseActivity(lease.id);
        this.store.addEvent(capability.threadId, "harness/service/start", `Started service ${lease.id}`);
        const policyApplications = await applyServiceStartedPolicies({
          artifactsDir: this.artifactsDir,
          store: this.store,
          runtimeBroker: this.runtimeBroker,
          service: lease,
          stack
        });
        return {
          text: `Prepared ${template.label} at ${lease.connection.uri ?? filePath}.${policyApplications.length > 0 ? ` Surfaced ${policyApplications.length} project policy hint${policyApplications.length === 1 ? "" : "s"}.` : ""}`,
          data: { service: lease, policyApplications }
        };
      }

      const service = await this.runtimeBroker.createService({
        serviceId: crypto.randomUUID(),
        threadId: capability.threadId,
        projectId: project.id,
        projectLabel: project.label,
        title: effectiveTitle,
        stackId: stack?.id ?? null,
        aliases,
        templateId: template.id,
        templateLabel: template.label,
        runtimeKind: template.runtimeKind,
        worktreePath: cwd,
        targetPort: template.defaultPort,
        image: template.image,
        command: template.command,
        workingDir: template.workingDir,
        stackVolumePath: template.stackVolumePath,
        env: { ...template.envDefaults, ...env }
      });
      const lease = toServiceLeaseView({
        id: service.id,
        threadId: service.threadId,
        projectId: service.projectId,
        projectLabel: service.projectLabel,
        title: service.title,
        stackId: service.stackId,
        aliases: service.aliases,
        template,
        containerName: service.containerName,
        targetHost: service.targetHost,
        targetPort: service.targetPort,
        worktreePath: service.worktreePath,
        status: service.status,
        storageKind: service.storageKind,
        sticky: service.sticky,
        volumeName: service.volumeName,
        volumeMountPath: service.volumeMountPath,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        lastError: service.lastError,
        env: service.env
      });
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(lease.id);
      this.store.addEvent(capability.threadId, "harness/service/start", `Started service ${lease.id}`);
      const policyApplications = await applyServiceStartedPolicies({
        artifactsDir: this.artifactsDir,
        store: this.store,
        runtimeBroker: this.runtimeBroker,
        service: lease,
        stack
      });
      return {
        text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.${lease.sticky ? ` Sticky volume=${lease.volumeName}.` : ""}${policyApplications.length > 0 ? ` Surfaced ${policyApplications.length} project policy hint${policyApplications.length === 1 ? "" : "s"}.` : ""}`,
        data: { service: lease, policyApplications }
      };
    }

    if (action === "service.inspect") {
      const existing = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (existing.runtimeKind === "embedded") {
        this.store.noteServiceLeaseActivity(existing.id);
        return {
          text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.`,
          data: { service: existing }
        };
      }
      const inspected = await this.runtimeBroker.inspectService(existing.id);
      const template = this.getServiceTemplate(inspected.templateId);
      const lease = toServiceLeaseView({
        id: inspected.id,
        threadId: inspected.threadId,
        projectId: inspected.projectId,
        projectLabel: inspected.projectLabel,
        title: inspected.title,
        stackId: inspected.stackId,
        aliases: inspected.aliases,
        template,
        containerName: inspected.containerName,
        targetHost: inspected.targetHost,
        targetPort: inspected.targetPort,
        worktreePath: inspected.worktreePath,
        status: inspected.status,
        storageKind: inspected.storageKind,
        sticky: inspected.sticky,
        volumeName: inspected.volumeName,
        volumeMountPath: inspected.volumeMountPath,
        createdAt: inspected.createdAt,
        updatedAt: inspected.updatedAt,
        lastError: inspected.lastError,
        env: inspected.env
      });
      this.store.upsertServiceLease(lease);
      this.store.noteServiceLeaseActivity(lease.id);
      return {
        text: `${lease.title} is ${inspected.runtime.status}. Host=${lease.connection.host} Port=${lease.connection.port}. Storage=${lease.storageKind}${lease.volumeName ? `(${lease.volumeName})` : ""}.`,
        data: { service: lease, runtime: inspected.runtime }
      };
    }

    if (action === "service.logs") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      const tail = typeof params.tail === "number" ? params.tail : Number(params.tail ?? 200);
      if (service.runtimeKind !== "container") {
        this.store.noteServiceLeaseActivity(service.id);
        return {
          text: `${service.title} is embedded and does not expose container logs.`,
          data: { service }
        };
      }
      const result = await this.runtimeBroker.readServiceLogs(service.id, Number.isFinite(tail) ? tail : 200);
      this.store.noteServiceLeaseActivity(service.id);
      return {
        text: result.logs || "No logs were returned.",
        data: { logs: result }
      };
    }

    if (action === "service.exec") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      const command = normalizeString(params.command);
      const commandArgs = normalizeStringArray(params.commandArgs);
      const cwd = normalizeString(params.cwd) || undefined;
      const stdin = typeof params.stdin === "string" ? params.stdin : undefined;
      const stdinProvided = params.stdinProvided === true;
      if (service.runtimeKind !== "container") {
        throw new Error(`${service.title} is embedded and does not support container exec`);
      }
      if (!command && commandArgs.length === 0) {
        throw new Error("service.exec requires command");
      }
      const result = await this.runtimeBroker.execInService({
        serviceId: service.id,
        command,
        commandArgs,
        cwd,
        stdin,
        stdinProvided
      });
      this.store.noteServiceLeaseActivity(service.id);
      const body = [
        `exitCode=${result.exitCode ?? "unknown"}`,
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        text: body || "Command completed with no output.",
        data: { result }
      };
    }

    if (action === "service.stop") {
      const service = await this.resolveThreadService(capability, normalizeString(params.serviceId));
      if (service.runtimeKind === "container") {
        await this.runtimeBroker.stopService(service.id);
      }
      this.store.removeServiceLease(service.id);
      this.store.addEvent(capability.threadId, "harness/service/stop", `Stopped service ${service.id}`);
      return {
        text: `Stopped ${service.title}.`,
        data: { serviceId: service.id }
      };
    }

    throw new Error(`Unknown Codex harness action: ${action}`);
  }
}
