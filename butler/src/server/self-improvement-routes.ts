import type express from "express";

import { buildButlerDelegationContract } from "./butler-agent-delegation-contract-builder.js";
import { buildDelegationDeveloperInstructions } from "./butler-agent-delegation-instructions.js";
import { buildSelfImprovementTask } from "./butler-self-improvement.js";
import type { CodexAppServerClient } from "./codex-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import { bindJobPayloadDelivery, jobPayloadsRoot, persistJobPayload } from "./job-instruction-artifacts.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import { buildCodexInputWithReferences } from "./reference-inputs.js";
import { cleanupManagedWorktree, ensureTaskWorktree } from "./repo-worktree.js";
import { commitSelfImprovementRequest, discardSelfImprovementRequest, openSelfImprovementPullRequest } from "./self-improvement-actions.js";
import { resolveSelfImprovementEligibility } from "./self-improvement-eligibility.js";
import type { SelfImprovementRequestState } from "./self-improvement-request-state.js";
import type { ButlerStateStore } from "./state-store.js";

type RouteAccess = {
  app: express.Express;
  requests: SelfImprovementRequestState;
  hostController: HostControllerClient;
  store: ButlerStateStore;
  codexClient: CodexAppServerClient;
  pairSessions?: Pick<PairSessionManager, "createWorkerPair">;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  artifactsDir: string;
  prepareWorkspace?: typeof ensureTaskWorktree;
};

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerSelfImprovementRoutes(access: RouteAccess): void {
  const { app, requests, hostController, store, codexClient, pairSessions, imageStore, fileStore, artifactsDir } = access;
  const prepareWorkspace = access.prepareWorkspace ?? ensureTaskWorktree;

  app.get("/api/self-improvement/requests", async (_request, response) => {
    response.json({ requests: requests.list(), eligibility: await resolveSelfImprovementEligibility(hostController) });
  });

  app.post("/api/self-improvement/requests/:requestId/dismiss", (request, response) => {
    try {
      response.json({ ok: true, request: requests.dismiss(request.params.requestId, readText(request.body?.reason) || null) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/self-improvement/requests/:requestId/approve", async (request, response) => {
    let approvedRequestId: string | null = null;
    let preparedWorkspaceCwd: string | null = null;
    try {
      const current = requests.get(request.params.requestId);
      if (!current || current.status !== "pending") throw new Error("Only pending self-improvement requests can be approved.");
      const eligibility = await resolveSelfImprovementEligibility(hostController);
      if (!eligibility.enabled) throw new Error(`Self-improvement is disabled: ${eligibility.reasons.join(" ")}`);
      const approved = requests.update(current.id, { status: "approved", approvedAt: Date.now() });
      approvedRequestId = approved.id;
      const task = buildSelfImprovementTask({ request: approved });
      const workspace = await prepareWorkspace({ cwd: eligibility.sourceCwd, task });
      preparedWorkspaceCwd = workspace.cwd;
      const developerInstructions = buildDelegationDeveloperInstructions(workspace, task);
      const result = await codexClient.startThread({
        task,
        input: async (threadId) => buildCodexInputWithReferences({
          text: (await buildButlerDelegationContract({
            store,
            threadId,
            task,
            goal: "Investigate and implement this approved Manor self-improvement request locally only.",
            workspace,
            extraNotes: [
              "This self-improvement request was operator-approved for local work only.",
              "Do not commit, push, open a pull request, restart Manor, deploy, or mutate the host unless the operator later asks explicitly.",
              "Report the local changes, verification, remaining risk, and whether a restart is needed."
            ]
          })).text,
          imageStore,
          imageReferenceIds: [],
          fileStore,
          fileReferenceIds: []
        }),
        cwd: workspace.cwd,
        developerInstructions,
        effort: "high",
        openWindow: true
      });
      const pair = pairSessions
        ? await pairSessions.createWorkerPair({
            title: `Self-improvement: ${approved.trigger}`,
            defaultCwd: workspace.cwd,
            threadId: result.threadId,
            task,
            cwd: workspace.cwd,
            handoffPrompt: task
          })
        : null;
      const contract = await buildButlerDelegationContract({
        store,
        threadId: result.threadId,
        task,
        goal: "Investigate and implement this approved Manor self-improvement request locally only.",
        workspace,
        extraNotes: ["Do not commit, push, open a pull request, restart Manor, deploy, or mutate the host unless the operator later asks explicitly."]
      });
      const boundPayload = bindJobPayloadDelivery(contract.payload, { turnId: result.turnId });
      await persistJobPayload(jobPayloadsRoot(artifactsDir), boundPayload);
      store.setThreadJobPayload(boundPayload);
      store.setThreadExecutionContract(result.threadId, contract.contract);
      store.addEvent(result.threadId, "butler.self_improvement.created", `Approved self-improvement request ${approved.id}.`);
      store.openWindow(result.threadId);
      preparedWorkspaceCwd = null;
      response.status(202).json({ ok: true, request: requests.update(approved.id, { status: "running", threadId: result.threadId, pairId: pair?.id ?? null, workspaceCwd: workspace.cwd, branchName: workspace.branchName, startedAt: Date.now() }) });
    } catch (error) {
      if (preparedWorkspaceCwd) await cleanupManagedWorktree(preparedWorkspaceCwd).catch(() => undefined);
      if (approvedRequestId) {
        try {
          requests.update(approvedRequestId, { status: "pending", approvedAt: null });
        } catch {}
      }
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/self-improvement/requests/:requestId/discard", async (request, response) => {
    try {
      response.json({ ok: true, request: await discardSelfImprovementRequest(requests, codexClient, request.params.requestId) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/self-improvement/requests/:requestId/commit", async (request, response) => {
    try {
      response.json({ ok: true, request: await commitSelfImprovementRequest(requests, request.params.requestId, readText(request.body?.message)) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/self-improvement/requests/:requestId/pr", async (request, response) => {
    try {
      response.json({
        ok: true,
        request: await openSelfImprovementPullRequest(requests, request.params.requestId, readText(request.body?.title), readText(request.body?.body))
      });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
