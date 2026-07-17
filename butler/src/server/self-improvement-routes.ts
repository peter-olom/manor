import type express from "express";
import path from "node:path";

import { buildButlerDelegationContract } from "./butler-agent-delegation-contract-builder.js";
import { buildDelegationDeveloperInstructions } from "./butler-agent-delegation-instructions.js";
import { buildSelfImprovementTask } from "./butler-self-improvement.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { FileReferenceStore } from "./file-store.js";
import type { HostControllerClient } from "./host-controller-client.js";
import type { ImageReferenceStore } from "./image-store.js";
import { bindJobPayloadDelivery, jobPayloadsRoot, persistJobPayload } from "./job-instruction-artifacts.js";
import type { PairSessionManager } from "./pair-session-manager.js";
import { buildWorkerInputWithReferences } from "./reference-inputs.js";
import { ensureWorkspaceWritableForWorker } from "./repo-worktree.js";
import { commitSelfImprovementRequest, deleteSelfImprovementRequest, discardSelfImprovementRequest, openSelfImprovementPullRequest, runSerializedSelfImprovementAction } from "./self-improvement-actions.js";
import { resolveSelfImprovementEligibility } from "./self-improvement-eligibility.js";
import type { SelfImprovementRequestState } from "./self-improvement-request-state.js";
import type { ButlerStateStore } from "./state-store.js";
import { deleteWorkerThread, startWorkerThread, type WorkerClientAccess } from "./worker-client-router.js";

type RouteAccess = {
  app: express.Express;
  requests: SelfImprovementRequestState;
  hostController: HostControllerClient;
  store: ButlerStateStore;
  piRpcWorkerClient?: PiRpcWorkerClient | null;
  pairSessions?: Pick<PairSessionManager, "createWorkerPair" | "deletePair" | "getPairWorkerThreadId">;
  imageStore: ImageReferenceStore;
  fileStore: FileReferenceStore;
  artifactsDir: string;
  getWorkerAffinity?: WorkerClientAccess["getWorkerAffinity"];
  recordSuccessfulWorkerSelection?: WorkerClientAccess["recordSuccessfulWorkerSelection"];
  prepareWorkerWorkspace?: WorkerClientAccess["prepareWorkerWorkspace"];
  removeExternalWorkerDelegation?: (threadId: string) => Promise<void>;
};

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerSelfImprovementRoutes(access: RouteAccess): void {
  const { app, requests, hostController, store, pairSessions, imageStore, fileStore, artifactsDir } = access;
  app.get("/api/self-improvement/requests", async (_request, response) => {
    response.json({ requests: requests.list(), eligibility: await resolveSelfImprovementEligibility(hostController) });
  });

  app.post("/api/self-improvement/requests/:requestId/dismiss", async (request, response) => {
    await runSerializedSelfImprovementAction(request.params.requestId, async () => {
      try {
        const current = requests.get(request.params.requestId);
        if (!current || current.status !== "pending") throw new Error("Only pending self-improvement requests can be dismissed.");
        const dismissed = requests.dismiss(request.params.requestId, readText(request.body?.reason) || null);
        await requests.flush();
        response.json({ ok: true, request: dismissed });
      } catch (error) {
        response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  app.post("/api/self-improvement/requests/:requestId/approve", async (request, response) => {
    await runSerializedSelfImprovementAction(request.params.requestId, async () => {
    let approvedRequestId: string | null = null;
    let startedThreadId: string | null = null;
    let createdPairId: string | null = null;
    try {
      const current = requests.get(request.params.requestId);
      if (!current || current.status !== "pending") throw new Error("Only pending self-improvement requests can be approved.");
      const prepareWorkerWorkspace = access.prepareWorkerWorkspace ?? ensureWorkspaceWritableForWorker;
      const eligibility = await resolveSelfImprovementEligibility(hostController, prepareWorkerWorkspace);
      if (!eligibility.enabled) throw new Error(`Self-improvement is disabled: ${eligibility.reasons.join(" ")}`);
      if (requests.hasSourceCheckoutOwner(current.id)) throw new Error("Another self-improvement worker is already using the active Manor source checkout.");
      const approved = requests.update(current.id, { status: "approved", approvedAt: Date.now() });
      await requests.flush();
      approvedRequestId = approved.id;
      const task = buildSelfImprovementTask({ request: approved });
      const workspace = {
        cwd: eligibility.sourceCwd,
        branchName: null
      };
      const developerInstructions = buildDelegationDeveloperInstructions(workspace, task);
      let delegation: Awaited<ReturnType<typeof buildButlerDelegationContract>> | null = null;
      const result = await startWorkerThread({ ...access, prepareWorkerWorkspace: async () => undefined }, {
        task,
        input: async (threadId) => {
          startedThreadId = threadId;
          await store.flushSave();
          requests.update(approved.id, {
            status: "running",
            threadId,
            workspaceCwd: workspace.cwd,
            branchName: workspace.branchName,
            startedAt: Date.now()
          });
          await requests.flush();
          delegation = await buildButlerDelegationContract({
            store,
            threadId,
            task,
            goal: "Investigate and implement this approved Manor self-improvement request locally only.",
            workspace,
            reviewBaselineRoot: path.join(artifactsDir, "review-baselines"),
            extraNotes: [
              "This self-improvement request was operator-approved for the active Manor source checkout.",
              "Leave the changes uncommitted so the operator can inspect and continue experimenting.",
              "Do not create a branch or worktree, commit, push, or open a pull request unless the operator later asks explicitly.",
              "Do not restart Manor directly. Report whether a source restart is needed so Butler can request operator authorization.",
              "Report the local changes, verification, remaining risk, and whether a restart is needed."
            ]
          });
          await persistJobPayload(jobPayloadsRoot(artifactsDir), delegation.payload);
          store.setThreadJobPayload(delegation.payload);
          store.setThreadExecutionContract(threadId, delegation.contract);
          return buildWorkerInputWithReferences({
            text: delegation.text,
            imageStore,
            imageReferenceIds: [],
            fileStore,
            fileReferenceIds: []
          });
        },
        cwd: workspace.cwd,
        developerInstructions,
        effort: "high",
        openWindow: true,
        runtime: "auto",
        ownsManorSourceCheckoutReservation: true
      });
      startedThreadId = result.threadId;
      let pair = null;
      if (pairSessions) {
        try {
          pair = await pairSessions.createWorkerPair({
            title: `Self-improvement: ${approved.trigger}`,
            defaultCwd: workspace.cwd,
            threadId: result.threadId,
            task,
            cwd: workspace.cwd,
            handoffPrompt: task,
            runtime: result.runtime,
            harness: result.harness,
            provider: result.provider,
            model: result.model,
            effort: result.effort
          });
        } catch (error) {
          const failedPairId = (error as { pairId?: unknown }).pairId;
          if (typeof failedPairId === "string" && failedPairId) createdPairId = failedPairId;
          throw error;
        }
      }
      createdPairId = pair?.id ?? null;
      if (createdPairId) {
        requests.update(approved.id, { pairId: createdPairId });
        await requests.flush();
      }
      const completedDelegation = delegation as Awaited<ReturnType<typeof buildButlerDelegationContract>> | null;
      if (!completedDelegation) throw new Error("Self-improvement Worker started without a persisted delegation contract.");
      const boundPayload = bindJobPayloadDelivery(completedDelegation.payload, { turnId: result.turnId });
      await persistJobPayload(jobPayloadsRoot(artifactsDir), boundPayload);
      store.setThreadJobPayload(boundPayload);
      store.addEvent(result.threadId, "butler.self_improvement.created", `Approved self-improvement request ${approved.id}.`);
      store.openWindow(result.threadId);
      const running = requests.update(approved.id, { threadId: result.threadId, pairId: pair?.id ?? null, workspaceCwd: workspace.cwd, branchName: workspace.branchName, startedAt: requests.get(approved.id)?.startedAt ?? Date.now() });
      await requests.flush();
      response.status(202).json({ ok: true, request: running });
    } catch (error) {
      let deleteError: unknown = null;
      let pairDeleteError: unknown = null;
      let requestRollbackError: unknown = null;
      let pairDeleted = false;
      if (createdPairId && pairSessions) {
        try {
          await pairSessions.deletePair(createdPairId);
          pairDeleted = true;
        } catch (caught) {
          pairDeleteError = caught;
        }
      }
      if (startedThreadId && !pairDeleteError) {
        try {
          await deleteWorkerThread(access, startedThreadId, { waitForCleanup: true });
        } catch (caught) {
          deleteError = caught;
        }
      }
      if (approvedRequestId) {
        try {
          requests.update(approvedRequestId, (deleteError || pairDeleteError) && startedThreadId
            ? { status: "running", threadId: startedThreadId, pairId: pairDeleted ? null : createdPairId, startedAt: Date.now() }
            : { status: "pending", approvedAt: null, threadId: null, pairId: null, workspaceCwd: null, branchName: null, startedAt: null });
          await requests.flush();
        } catch (caught) {
          requestRollbackError = caught;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const deleteMessage = deleteError ? ` Worker cleanup also failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}` : "";
      const pairMessage = pairDeleteError ? ` Pair cleanup also failed: ${pairDeleteError instanceof Error ? pairDeleteError.message : String(pairDeleteError)}` : "";
      const rollbackMessage = requestRollbackError ? ` Request recovery also failed: ${requestRollbackError instanceof Error ? requestRollbackError.message : String(requestRollbackError)}` : "";
      response.status(409).json({ error: `${message}${deleteMessage}${pairMessage}${rollbackMessage}` });
    }
    });
  });

  app.post("/api/self-improvement/requests/:requestId/discard", async (request, response) => {
    try {
      response.json({ ok: true, request: await discardSelfImprovementRequest(requests, access, request.params.requestId) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/self-improvement/requests/:requestId/delete", async (request, response) => {
    try {
      response.json({
        ok: true,
        request: await deleteSelfImprovementRequest(requests, access, request.params.requestId, {
          removeExternalWorkerDelegation: access.removeExternalWorkerDelegation,
          resolvePairWorkerThreadId: (pairId) => pairSessions?.getPairWorkerThreadId(pairId) ?? null
        })
      });
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
