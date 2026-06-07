import type express from "express";

import type { ButlerAgentService } from "./butler-agent.js";
import type { CodexAppServerClient } from "./codex-client.js";
import { type FileReferenceStore } from "./file-store.js";
import { type ImageReferenceStore } from "./image-store.js";
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import {
  cleanupManagedWorktree,
  ensureTaskWorktree,
  isManagedWorktree,
  resolveExistingWorkspaceCwd,
  resolveWorkspaceBranchName,
  resolveWorkspaceProjectInfo
} from "./repo-worktree.js";
import { ScratchPadStore } from "./scratch-pad-store.js";
import { ButlerStateStore } from "./state-store.js";
import { buildThreadExecutionContract, describeProofExpectation } from "./thread-contract.js";
import type { ScratchPadItemView, ScratchPadWorkspaceMode } from "./types.js";

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
  codexClient: CodexAppServerClient;
  butlerAgent: ButlerAgentService;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  prepareScratchWorkspace?: (item: ScratchPadItemView, task: string, baseCwd: string) => Promise<ScratchWorkspace>;
  cleanupScratchWorkspace?: (cwd: string) => Promise<number>;
};

function buildScratchTask(item: ScratchPadItemView): string {
  return [
    "Scratch pad async investigation.",
    "",
    `Title: ${item.title}`,
    "",
    "Idea:",
    item.text,
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

async function buildScratchInput(
  access: ScratchPadRoutesAccess,
  item: ScratchPadItemView,
  threadId: string,
  task: string,
  workspace: ScratchWorkspace
) {
  const cwd = workspace.cwd;
  const project = resolveWorkspaceProjectInfo(cwd);
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: cwd,
    projectId: project.id,
    projectLabel: project.label,
    branch: workspace.branchName,
    taskText: task,
    requestedTask: task,
    operatorGoal: "Explore this scratch pad item deeply and return a reviewable async result.",
    notes: [
      "This job came from the scratch pad.",
      "Prefer safe reads, research, and disposable prototypes until the operator accepts the idea."
    ]
  });
  const lines = [
    "MANOR JOB BRIEF",
    `thread_id: ${threadId}`,
    `workspace_cwd: ${cwd}`,
    `project_id: ${project.id}`,
    `project_label: ${project.label}`,
    `branch: ${workspace.branchName ?? (workspace.workspaceMode === "managed_worktree" ? "(managed worktree)" : "(existing workspace)")}`,
    `harness_binding: manor-harness --thread ${threadId}`,
    `proof_expectation: ${describeProofExpectation(contract.proofExpectation)}`
  ];
  for (const point of contract.acceptancePoints) lines.push(`acceptance_point: ${point}`);
  if (contract.operatorGoal) lines.push(`operator_goal: ${contract.operatorGoal}`);
  for (const note of contract.notes) lines.push(`note: ${note}`);
  access.store.setThreadExecutionContract(threadId, contract);
  return buildCodexInputWithReferences({
    text: `${lines.join("\n")}\n\nREQUESTED TASK\n${task}`,
    imageStore: access.imageStore,
    imageReferenceIds: [],
    fileStore: access.fileStore,
    fileReferenceIds: []
  });
}

function buildDeveloperInstructions(workspace: ScratchWorkspace): string {
  return [
    "This thread was started from Butler's scratch pad.",
    "Work asynchronously and go deeper than a normal chat answer.",
    workspace.workspaceMode === "managed_worktree"
      ? `Work inside the isolated scratch-pad worktree at ${workspace.cwd}.`
      : `Work inside ${workspace.cwd} unless the scratch idea clearly requires finding or creating another workspace under /repos.`,
    "Use Codex-shell for repository, git, and code-editing work.",
    "Read memory before acting when the idea depends on prior work, project conventions, unresolved outcomes, or attribution.",
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
  let result: Awaited<ReturnType<CodexAppServerClient["startThread"]>>;
  try {
    result = await access.codexClient.startThread({
      task,
      input: (threadId) => buildScratchInput(access, item, threadId, task, workspace),
      cwd: workspace.cwd,
      developerInstructions: buildDeveloperInstructions(workspace),
      effort: "high",
      openWindow: true
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
  access.store.addEvent(result.threadId, "butler.scratch_pad.started", "Butler started this job from a scratch pad item.");
  access.butlerAgent.trackScratchPadDelegation(result.threadId);
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
      const item = access.scratchPadStore.create({ title, text, cwd, workspaceMode });
      const started = autoStart ? await startScratchItem(access, item.id) : item;
      response.status(201).json({ ok: true, item: started });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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
        ? await access.codexClient.deleteThread(item.threadId, { waitForCleanup: true })
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
      response.json({ ok: true, item: removed, threadDeleted: Boolean(item.threadId), deletedArtifacts: cleanup.deletedArtifacts + workspaceArtifacts });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
