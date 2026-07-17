import path from "node:path";

import type express from "express";

import type { PairStore } from "./pair-store.js";
import type { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import type { WorkerSessionControlAction, WorkerSessionControls } from "../shared/worker-session-controls.js";

type WorkerSessionControlRouteAccess = {
  app: express.Express;
  pairStore: PairStore;
  piRpcWorkerClient: PiRpcWorkerClient;
};

const UNAVAILABLE_CONTROLS: WorkerSessionControls = {
  supported: false,
  runtime: "pi",
  busy: false,
  compacting: false,
  autoCompactionEnabled: false,
  pendingMessageCount: 0,
  sessionName: null,
  stats: null,
  forkPoints: [],
  leafId: null
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function piWorkerThread(access: WorkerSessionControlRouteAccess, pairId: string): { threadId: string } | null {
  const worker = access.pairStore.getPair(pairId)?.worker;
  if (!worker || worker.runtime !== "pi-rpc") return null;
  return { threadId: worker.threadId };
}

async function runAction(
  client: PiRpcWorkerClient,
  threadId: string,
  action: WorkerSessionControlAction,
  body: unknown
): Promise<unknown> {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (action === "compact") {
    await client.compactThread(threadId, readString(input.instructions));
    return { ok: true };
  }
  if (action === "abort-retry") {
    await client.abortThreadRetry(threadId);
    return { ok: true };
  }
  if (action === "clone") return client.cloneThread(threadId);
  if (action === "rename") {
    await client.renameThreadSession(threadId, readString(input.name));
    return { ok: true };
  }
  const entryId = readString(input.entryId);
  if (!entryId) throw new Error("A branch point is required.");
  const controls = await client.getSessionControls(threadId);
  if (!controls.forkPoints.some((point) => point.entryId === entryId)) throw new Error("The selected branch point is no longer available.");
  return client.forkThread(threadId, entryId);
}

export function registerWorkerSessionControlRoutes(access: WorkerSessionControlRouteAccess): void {
  access.app.get("/api/pairs/:pairId/worker/controls", async (request, response) => {
    const worker = piWorkerThread(access, request.params.pairId);
    if (!worker) {
      response.json({ controls: UNAVAILABLE_CONTROLS });
      return;
    }
    try {
      response.json({ controls: await access.piRpcWorkerClient.getSessionControls(worker.threadId) });
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.post("/api/pairs/:pairId/worker/controls/:action", async (request, response) => {
    const worker = piWorkerThread(access, request.params.pairId);
    if (!worker) {
      response.status(409).json({ error: "These session controls are available for Pi workers." });
      return;
    }
    const action = request.params.action as WorkerSessionControlAction;
    if (!["compact", "abort-retry", "fork", "clone", "rename"].includes(action)) {
      response.status(404).json({ error: "Unknown Worker session action." });
      return;
    }
    try {
      const result = await runAction(access.piRpcWorkerClient, worker.threadId, action, request.body);
      response.json(result);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  access.app.get("/api/pairs/:pairId/worker/export", async (request, response) => {
    const worker = piWorkerThread(access, request.params.pairId);
    if (!worker) {
      response.status(409).json({ error: "HTML export is available for Pi workers." });
      return;
    }
    try {
      const exportPath = await access.piRpcWorkerClient.exportThreadHtml(worker.threadId);
      response.download(exportPath, `${path.basename(worker.threadId)}.html`);
    } catch (error) {
      response.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
