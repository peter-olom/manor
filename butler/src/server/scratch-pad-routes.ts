import type express from "express";
import path from "node:path";

import type { ButlerAgentService } from "./butler-agent.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import { type FileReferenceStore } from "./file-store.js";
import { type ImageReferenceStore } from "./image-store.js";
import { bindJobPayloadDelivery, buildJobPayload, formatJobPayloadMessage, jobPayloadsRoot, persistJobPayload } from "./job-instruction-artifacts.js";
import { captureGitReviewBaseline, resolveGitRoot } from "./git-review-scope.js";
import { runSerializedJobMutation } from "./butler-job-mutation-guard.js";
import { buildWorkerInputWithReferences } from "./reference-inputs.js";
import {
  cleanupManagedWorktree,
  ensureWorkspaceWritableForWorker,
  ensureTaskWorktree,
  isManagedWorktree,
  resolveExistingWorkspaceCwd,
  resolveWorkspaceBranchName,
  resolveWorkspaceProjectInfo
} from "./repo-worktree.js";
import { ScratchPadStore } from "./scratch-pad-store.js";
import { ButlerStateStore } from "./state-store.js";
import { buildThreadExecutionContract, inferTaskCategory } from "./thread-contract.js";
import type { CodexTaskCategory, ScratchPadAttachmentView, ScratchPadItemView, ScratchPadResultKind, ScratchPadWorkspaceMode } from "./types.js";
import { deleteWorkerThread, startWorkerThread } from "./worker-client-router.js";

type ScratchWorkspace = {
  cwd: string;
  workspaceMode: ScratchPadWorkspaceMode;
  branchName: string | null;
  created: boolean;
};

type ScratchPadRoutesAccess = {
  app: express.Express;
  scratchPadStore: ScratchPadStore;
  store: ButlerStateStore;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  butlerAgent: ButlerAgentService;
  artifactsDir: string;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  prepareScratchWorkspace?: (item: ScratchPadItemView, task: string, baseCwd: string) => Promise<ScratchWorkspace>;
  cleanupScratchWorkspace?: (cwd: string) => Promise<number>;
  prepareWorkerWorkspace?: typeof ensureWorkspaceWritableForWorker;
};

function buildScratchTask(item: ScratchPadItemView): string {
  const attachmentLines =
    item.attachments.length > 0
      ? ["", "Attached context:", ...item.attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.kind})`)]
      : [];
  return [
    "Scratch pad async investigation.",
    "",
    `Title: ${item.title}`,
    "",
    "Idea:",
    item.text,
    ...attachmentLines,
    "",
    "Choose the right investigation shape yourself. Research, prototype, plan, or recommend based on what best advances the idea.",
    "Work longer and deeper than a chat reply: inspect relevant context, use memory when useful, run focused research or experiments, and come back with evidence.",
    "If a disposable prototype is useful and safe, build the smallest one that proves or disproves the idea.",
    "",
    "Return to Butler with:",
    "- what you did",
    "- what you found or built",
    "- evidence or commands that support it",
    "- risks or assumptions",
    "- the single review action the operator should take next",
    "",
    "Do not commit or push. If you change files for a prototype, keep the scope disposable and say exactly what changed."
  ].join("\n");
}

function taskCategoryFromResultKind(resultKind: ScratchPadResultKind): CodexTaskCategory {
  if (resultKind === "prototype") return "prototype";
  if (resultKind === "plan") return "plan";
  if (resultKind === "recommendation") return "recommendation";
  return "research";
}

function taskCategoryForScratchItem(item: ScratchPadItemView): CodexTaskCategory {
  const inferred = inferTaskCategory(item.text);
  return inferred === "unknown" || inferred === "read_only" ? taskCategoryFromResultKind(item.resultKind) : inferred;
}

function inferScratchResultKind(text: string): ScratchPadResultKind {
  if (/\b(prototype|spike|proof of concept|poc|mock|experiment|build a small|try a small)\b/i.test(text)) {
    return "prototype";
  }
  if (/\b(plan|roadmap|checklist|spec|proposal|phases?|implementation path)\b/i.test(text)) {
    return "plan";
  }
  if (/\b(recommend|recommendation|decide|advise|which option|pick an option|what should we do)\b/i.test(text)) {
    return "recommendation";
  }
  return "research";
}

function readReferenceIds(body: unknown, key: string): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))]
    : [];
}

function buildScratchAttachments(
  access: ScratchPadRoutesAccess,
  imageReferenceIds: string[],
  fileReferenceIds: string[]
): ScratchPadAttachmentView[] {
  const now = Date.now();
  const images = access.imageStore.resolveViews(imageReferenceIds).map((image) => ({
    id: `image-${image.id}`,
    kind: "image" as const,
    referenceId: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    url: image.url,
    available: true,
    used: false,
    note: null,
    createdAt: image.createdAt || now
  }));
  const files = access.fileStore.resolveViews(fileReferenceIds).map((file) => ({
    id: `file-${file.id}`,
    kind: "file" as const,
    referenceId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    url: file.url,
    available: true,
    used: false,
    note: null,
    createdAt: file.createdAt || now
  }));
  return [...images, ...files];
}

async function buildScratchInput(
  access: ScratchPadRoutesAccess,
  item: ScratchPadItemView,
  threadId: string,
  task: string,
  workspace: ScratchWorkspace
) {
  const cwd = workspace.cwd;
  const project = resolveWorkspaceProjectInfo(cwd);
  const reviewGitRoot = await resolveGitRoot(cwd);
  const reviewBaseline = reviewGitRoot ? await captureGitReviewBaseline(reviewGitRoot, path.join(access.artifactsDir, "review-baselines")) : null;
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: cwd,
    projectId: project.id,
    projectLabel: project.label,
    branch: workspace.branchName,
    taskText: item.text,
    requestedTask: `${item.resultKind} scratch-pad result: ${item.text}`,
    operatorGoal: "Explore this scratch pad item deeply and return a reviewable async result.",
    taskCategory: taskCategoryForScratchItem(item),
    inferredWorkDepth: "deep",
    attachmentCount: item.attachments.length,
    notes: [
      "This job came from the scratch pad.",
      item.attachments.length > 0 ? "Scratch pad attachments are first-class task context; inspect the relevant files or images directly." : "",
      "Prefer safe reads, research, and disposable prototypes until the operator accepts the idea."
    ]
  });
  const reviewableContract = {
    ...contract,
    reviewBaselineCwd: reviewBaseline?.cwd ?? null,
    reviewBaselineSha: reviewBaseline?.sha ?? null,
    reviewBaselineTreeSha: reviewBaseline?.treeSha ?? null,
    reviewBaselineObjectDir: reviewBaseline?.objectDir ?? null,
    reviewBaselineCaptureFailed: Boolean(reviewGitRoot && !reviewBaseline)
  };
  access.store.setThreadExecutionContract(threadId, reviewableContract);
  const imageReferenceIds = item.attachments.filter((attachment) => attachment.kind === "image" && attachment.available).map((attachment) => attachment.referenceId);
  const fileReferenceIds = item.attachments.filter((attachment) => attachment.kind === "file" && attachment.available).map((attachment) => attachment.referenceId);
  const payload = buildJobPayload({
    threadId,
    kind: "delegation",
    instruction: task,
    contract: reviewableContract,
    imageReferenceIds,
    fileReferenceIds
  });
  await persistJobPayload(jobPayloadsRoot(access.artifactsDir), payload);
  access.store.setThreadJobPayload(payload);
  return buildWorkerInputWithReferences({
    text: formatJobPayloadMessage("delegation", threadId, payload.requestedTask, payload.display.summary),
    imageStore: access.imageStore,
    imageReferenceIds,
    fileStore: access.fileStore,
    fileReferenceIds
  });
}

function buildDeveloperInstructions(workspace: ScratchWorkspace): string {
  return [
    "This thread was started from Butler's scratch pad.",
    "Work asynchronously and go deeper than a normal chat answer.",
    workspace.workspaceMode === "managed_worktree"
      ? `Work inside the isolated scratch-pad worktree at ${workspace.cwd}.`
      : `Work inside ${workspace.cwd} unless the scratch idea clearly requires finding or creating another workspace under /repos.`,
    "Use the worker shell for repository, git, and code-editing work.",
    "Run every install, build, test, script, server, conversion, and project program inside a preview through manor-harness.",
    "Inspect scratch-pad attachments directly when they matter; do not depend on Butler transcript context for attached files.",
    "Read memory before acting when the idea depends on prior work, project conventions, unresolved outcomes, or attribution.",
    "Preserve the operator's intent from the scratch idea and attached context. Do not shrink a broad idea into the easiest literal subtask.",
    "Be industrious inside the job boundary: inspect current state, run focused checks, use previews or logs when behavior matters, and follow weak evidence before reporting done.",
    "Taste is part of completion for UI, product, writing, and operator-facing workflow work. Check hierarchy, spacing, density, copy, states, accessibility, responsiveness, and workflow coherence.",
    "Use previews, command checks, or file artifacts when they materially improve the review result.",
    "Keep visible progress brief and useful.",
    "Do not commit or push.",
    "When complete, record a supervisor report with manor-harness report. Include the result type, evidence, risks, and the next operator action."
  ].join("\n");
}

async function prepareScratchWorkspace(item: ScratchPadItemView, task: string, baseCwd: string): Promise<ScratchWorkspace> {
  if (item.workspaceMode === "existing") {
    return {
      cwd: baseCwd,
      workspaceMode: "existing",
      branchName: await resolveWorkspaceBranchName(baseCwd),
      created: false
    };
  }

  const worktree = await ensureTaskWorktree({ cwd: baseCwd, task: `scratchpad ${item.title}` });
  const managed = isManagedWorktree(worktree.cwd);
  return {
    cwd: worktree.cwd,
    workspaceMode: managed ? "managed_worktree" : "existing",
    branchName: worktree.branchName,
    created: worktree.created
  };
}

function resolveDefaultScratchCwd(access: ScratchPadRoutesAccess): string {
  const threadId = access.store.getOpenWindowIds()[0] ?? null;
  const thread = threadId ? access.store.getThread(threadId) : null;
  return thread?.cwd ?? thread?.executionContract?.workspaceCwd ?? "/repos";
}

async function startScratchItem(access: ScratchPadRoutesAccess, itemId: string) {
  const item = access.scratchPadStore.get(itemId);
  if (!item) {
    throw new Error("Scratch item not found");
  }
  if (item.threadId) {
    return item;
  }

  const task = buildScratchTask(item);
  const baseCwd = await resolveExistingWorkspaceCwd(item.cwd ?? resolveDefaultScratchCwd(access));
  const workspace = await (access.prepareScratchWorkspace ?? prepareScratchWorkspace)(item, task, baseCwd);
  let result: Awaited<ReturnType<typeof startWorkerThread>>;
  try {
    result = await startWorkerThread({
      ...access,
      getWorkerAffinity: () => access.butlerAgent.getWorkerAffinity(),
      recordSuccessfulWorkerSelection: (selection) => access.butlerAgent.recordSuccessfulWorkerSelection(selection)
    }, {
      task,
      input: (threadId) => buildScratchInput(access, item, threadId, task, workspace),
      cwd: workspace.cwd,
      developerInstructions: buildDeveloperInstructions(workspace),
      effort: "high",
      openWindow: true,
      runtime: "auto"
    });
  } catch (error) {
    if (workspace.created && workspace.workspaceMode === "managed_worktree") {
      await (access.cleanupScratchWorkspace ?? cleanupManagedWorktree)(workspace.cwd).catch(() => undefined);
    }
    throw error;
  }
  const updated = access.scratchPadStore.start(item.id, {
    threadId: result.threadId,
    cwd: workspace.cwd,
    workspaceMode: workspace.workspaceMode,
    branchName: workspace.branchName
  });
  const payload = access.store.getThreadJobPayload(result.threadId);
  if (payload) {
    const bound = bindJobPayloadDelivery(payload, { turnId: result.turnId });
    await persistJobPayload(jobPayloadsRoot(access.artifactsDir), bound);
    access.store.setThreadJobPayload(bound);
  }
  access.store.addEvent(result.threadId, "butler.scratch_pad.started", "Butler started this job from a scratch pad item.");
  await access.butlerAgent.trackScratchPadDelegation(result.threadId);
  return updated;
}

export function registerScratchPadRoutes(access: ScratchPadRoutesAccess): void {
  access.app.get("/api/scratch-pad", (_request, response) => {
    response.json({
      scratchPad: access.scratchPadStore.getSnapshot((threadId) => access.store.getThread(threadId))
    });
  });

  access.app.post("/api/scratch-pad/items", async (request, response) => {
    const text = typeof request.body?.text === "string" ? request.body.text : "";
    const title = typeof request.body?.title === "string" ? request.body.title : null;
    const cwd = typeof request.body?.cwd === "string" ? request.body.cwd : null;
    const workspaceMode = request.body?.workspaceMode === "existing" ? "existing" : "managed_worktree";
    const autoStart = request.body?.autoStart !== false;
    try {
      const attachments = buildScratchAttachments(
        access,
        readReferenceIds(request.body, "imageReferenceIds"),
        readReferenceIds(request.body, "fileReferenceIds")
      );
      const item = access.scratchPadStore.create({ title, text, cwd, workspaceMode, attachments, resultKind: inferScratchResultKind(text) });
      const started = autoStart ? await startScratchItem(access, item.id) : item;
      response.status(201).json({ ok: true, item: started });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.post("/api/scratch-pad/items/:itemId/attachments/:attachmentId/remove", (request, response) => {
    const itemId = typeof request.params.itemId === "string" ? request.params.itemId : "";
    const attachmentId = typeof request.params.attachmentId === "string" ? request.params.attachmentId : "";
    try {
      response.json({ ok: true, item: access.scratchPadStore.removeAttachment(itemId, attachmentId) });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.post("/api/scratch-pad/items/:itemId/start", async (request, response) => {
    const itemId = typeof request.params.itemId === "string" ? request.params.itemId : "";
    try {
      const item = await startScratchItem(access, itemId);
      response.json({ ok: true, item });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.post("/api/scratch-pad/items/:itemId/review", (request, response) => {
    const itemId = typeof request.params.itemId === "string" ? request.params.itemId : "";
    const status = request.body?.status;
    if (status !== "accepted" && status !== "parked" && status !== "dismissed") {
      response.status(400).json({ error: "status must be accepted, parked, or dismissed" });
      return;
    }
    const note = typeof request.body?.note === "string" ? request.body.note : null;
    try {
      response.json({ ok: true, item: access.scratchPadStore.review(itemId, status, note) });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.post("/api/scratch-pad/items/:itemId/delete", async (request, response) => {
    const itemId = typeof request.params.itemId === "string" ? request.params.itemId : "";
    const item = access.scratchPadStore.get(itemId);
    if (!item) {
      response.status(404).json({ error: "Scratch item not found" });
      return;
    }

    try {
      const cleanup = item.threadId
        ? await runSerializedJobMutation(item.threadId, async () => {
            try {
              return await deleteWorkerThread(access, item.threadId!, { waitForCleanup: true }) as { deletedArtifacts?: number; cleanupFailed?: boolean; cleanupError?: string | null };
            } finally {
              if (!access.store.getThread(item.threadId!)) await access.butlerAgent.removeExternalWorkerDelegation(item.threadId!);
            }
          })
        : { deletedArtifacts: 0, cleanupFailed: false, cleanupError: null };
      if (cleanup.cleanupFailed) {
        response.status(500).json({ error: cleanup.cleanupError ?? "Thread cleanup failed" });
        return;
      }
      const workspaceArtifacts =
        item.workspaceMode === "managed_worktree" && item.cwd
          ? await (access.cleanupScratchWorkspace ?? cleanupManagedWorktree)(item.cwd)
          : 0;

      const removed = access.scratchPadStore.remove(itemId);
      if (!removed) {
        response.status(404).json({ error: "Scratch item not found" });
        return;
      }
      response.json({ ok: true, item: removed, threadDeleted: Boolean(item.threadId), deletedArtifacts: (cleanup.deletedArtifacts ?? 0) + workspaceArtifacts });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
