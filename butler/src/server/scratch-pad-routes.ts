import type express from "express";

import type { ButlerAgentService } from "./butler-agent.js";
import type { CodexAppServerClient } from "./codex-client.js";
import { type FileReferenceStore } from "./file-store.js";
import { type ImageReferenceStore } from "./image-store.js";
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import { resolveExistingWorkspaceCwd, resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { ScratchPadStore } from "./scratch-pad-store.js";
import { ButlerStateStore } from "./state-store.js";
import { buildThreadExecutionContract, describeProofExpectation } from "./thread-contract.js";
import type { ScratchPadItemView } from "./types.js";

type ScratchPadRoutesAccess = {
  app: express.Express;
  scratchPadStore: ScratchPadStore;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  butlerAgent: ButlerAgentService;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
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

async function buildScratchInput(access: ScratchPadRoutesAccess, item: ScratchPadItemView, threadId: string, task: string, cwd: string) {
  const project = resolveWorkspaceProjectInfo(cwd);
  const contract = buildThreadExecutionContract({
    threadId,
    workspaceCwd: cwd,
    projectId: project.id,
    projectLabel: project.label,
    branch: null,
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
    "branch: (existing workspace)",
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

function buildDeveloperInstructions(cwd: string): string {
  return [
    "This thread was started from Butler's scratch pad.",
    "Work asynchronously and go deeper than a normal chat answer.",
    `Work inside ${cwd} unless the scratch idea clearly requires finding or creating another workspace under /repos.`,
    "Use Codex-shell for repository, git, and code-editing work.",
    "Read memory before acting when the idea depends on prior work, project conventions, unresolved outcomes, or attribution.",
    "Use previews, command checks, or file artifacts when they materially improve the review result.",
    "Keep visible progress brief and useful.",
    "Do not commit or push.",
    "When complete, record a supervisor report with manor-harness report. Include the result type, evidence, risks, and the next operator action."
  ].join("\n");
}

async function startScratchItem(access: ScratchPadRoutesAccess, itemId: string) {
  const item = access.scratchPadStore.get(itemId);
  if (!item) {
    throw new Error("Scratch item not found");
  }
  if (item.threadId) {
    return item;
  }

  const cwd = await resolveExistingWorkspaceCwd(item.cwd ?? "/repos");
  const task = buildScratchTask(item);
  const result = await access.codexClient.startThread({
    task,
    input: (threadId) => buildScratchInput(access, item, threadId, task, cwd),
    cwd,
    developerInstructions: buildDeveloperInstructions(cwd),
    effort: "high",
    openWindow: true
  });
  const updated = access.scratchPadStore.start(item.id, { threadId: result.threadId });
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
    const autoStart = request.body?.autoStart !== false;
    try {
      const item = access.scratchPadStore.create({ title, text, cwd });
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

  access.app.post("/api/scratch-pad/items/:itemId/delete", (request, response) => {
    const itemId = typeof request.params.itemId === "string" ? request.params.itemId : "";
    const item = access.scratchPadStore.remove(itemId);
    if (!item) {
      response.status(404).json({ error: "Scratch item not found" });
      return;
    }
    response.json({ ok: true, item });
  });
}
