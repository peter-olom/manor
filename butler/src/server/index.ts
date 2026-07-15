import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";

import { ButlerAgentService } from "./butler-agent.js"; import { directWorkerDispatchMarker } from "./butler-callback-state.js";
import { settleFailedDirectWorkerDispatch } from "./direct-codex-message.js";
import { runSerializedJobMutation, runSerializedJobMutations } from "./butler-job-mutation-guard.js";
import { createBackgroundModelServices } from "./background-model-services.js";
import { CodexAppServerClient } from "./codex-client.js";
import { HarnessService } from "./codex-harness.js";
import { loadReferenceStores, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "./reference-stores.js";
import { HostControllerClient } from "./host-controller-client.js";
import { createManorSettingsApplyHandler } from "./manor-settings-apply.js";
import { defaultManorSettingsPath, ManorSettingsService } from "./manor-settings-service.js"; import { MANOR_VERSION } from "./manor-version.js";
import { setActiveManorSettingsService, getActiveManorSettings } from "./manor-settings-runtime.js";
import { registerManorSettingsRoutes } from "./manor-settings-routes.js";
import { createModelUsageStore } from "./create-model-usage-store.js"; import { registerModelUsageRoutes } from "./model-usage-routes.js";
import { createProviderModelRefreshCoordinator, startOllamaCloudModelRecovery } from "./provider-model-refresh.js"; import { normalizeMemoryCodexModelEnv } from "./memory-codex-model.js";
import { getMemoryDebugTrace, listMemoryDebugTraces } from "./memory-debug-traces.js";
import { buildMemoryDiagnostics } from "./memory-diagnostics.js";
import { PairSessionManager } from "./pair-session-manager.js";
import { PairStore } from "./pair-store.js"; import { SessionAutomationScheduler } from "./session-automation-scheduler.js";
import { PiRpcWorkerClient } from "./pi-rpc-worker-client.js";
import { registerPairRoutes } from "./pair-routes.js";
import { registerPreviewAnnotationRoutes } from "./preview-annotation-routes.js";
import { registerProjectArtifactPolicyRoutes } from "./project-artifact-policy-routes.js";
import { buildComposerInputItemsPrompt, buildReferencePromptText, buildWorkerInputWithReferences } from "./reference-inputs.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { registerScratchPadRoutes } from "./scratch-pad-routes.js"; import { registerSkillsRoutes } from "./skills-routes.js"; import { SkillsService } from "./skills-service.js"; import { ExtensionUiBroker } from "./extension-ui-broker.js"; import { registerExtensionUiRoutes } from "./extension-ui-routes.js"; import { registerWorkerSessionControlRoutes } from "./worker-session-control-routes.js"; import { registerButlerSessionControlRoutes } from "./butler-session-control-routes.js";
import { registerRuntimeResourceRoutes } from "./runtime-resource-routes.js";
import { ScratchPadStore } from "./scratch-pad-store.js";
import { registerServerAssetRoutes } from "./server-asset-routes.js";
import { isBinaryUploadRequest, shouldParseJsonRequest } from "./upload-request.js";
import { registerDeviceAuthRoutes } from "./device-auth-routes.js";
import { ManorSessionTitleGenerator, readSessionTitleConfig } from "./session-title-generator.js";
import { ManorModelTaskRunner } from "./model-task-runner.js";
import { VisionInspectionService } from "./vision-inspection.js";
import { configureSelfImprovementRequestState, SelfImprovementRequestState } from "./self-improvement-request-state.js";
import { configureSelfImprovementPairCleanup, reconcileInterruptedSelfImprovementRequests } from "./self-improvement-actions.js";
import { registerSelfImprovementRoutes } from "./self-improvement-routes.js";
import { retrieveButlerMemoryWithEmbeddings } from "./memory-retrieval.js";
import { registerManorRestartRoutes } from "./manor-restart-routes.js";
import { proxyPreviewRoute, registerPreviewProxyResponseRewriter, resolvePreviewRefererRouteUrl, resolvePreviewRouteUrl } from "./preview-gateway.js";
import { preserveMissingPreviewLeaseTombstones } from "./preview-lease-reconciliation.js";
import { reconcileDesktopSessions, registerDesktopSessionRoutes } from "./server-desktop-routes.js";
import { ButlerSseHub, cleanupThreadRuntimeResources, currentBootstrapSnapshot, pruneEmptyArtifactParents, readImageReferenceIds, readFileReferenceIds, removeStackArtifactsFromStore, resolvePreviewProxyTarget, resolveSseStateChannels, shouldAllowLocalThreadWindow, type RuntimeServerAccess } from "./server-runtime-helpers.js";
import { ServiceTemplateRegistry, toServiceLeaseView } from "./service-templates.js";
import { ButlerStateStore } from "./state-store.js";
import { registerThreadArtifactRoutes } from "./thread-artifact-routes.js";
import { deleteAllWorkerThreads, deleteWorkerThread, loadWorkerThread, sendWorkerMessage, stopWorkerThread, updateUnifiedWorkerCompose, updateWorkerThreadEffort } from "./worker-client-router.js";

normalizeMemoryCodexModelEnv(process.env);

const port = Number(process.env.BUTLER_PORT ?? "8080");
const codexBaseUrl = process.env.CODEX_BASE_URL ?? "ws://codex-box:8080";
const codexAppServerAuthTokenFile = process.env.CODEX_APP_SERVER_AUTH_TOKEN_FILE ?? null;
const piAgentDir = process.env.PI_AGENT_DIR ?? "/home/butler/.pi/agent";
const workerPiAgentDir = process.env.WORKER_PI_AGENT_DIR ?? piAgentDir; const workerPiSessionRoot = process.env.WORKER_PI_SESSION_ROOT ?? path.join(process.env.MANOR_STATE_DIR ?? "/state", "pi-worker-sessions");
const workerPiRpcCliPath = process.env.WORKER_PI_RPC_CLI_PATH ?? null; const workerPiExtensionDir = process.env.WORKER_PI_EXTENSION_DIR ?? null; const workerButlerBaseUrl = process.env.WORKER_BUTLER_BASE_URL ?? `http://127.0.0.1:${port}`;
const stateDir = process.env.MANOR_STATE_DIR ?? "/state";
const codexHomeDir = process.env.CODEX_SHARED_HOME_DIR ?? "/codex-home";
const harnessRegistryPath = process.env.MANOR_HARNESS_REGISTRY_PATH ?? path.join(stateDir, "harness-capabilities.json");
const harnessAccessPath = process.env.MANOR_HARNESS_ACCESS_FILE ?? path.join(stateDir, "harness-broker-access.json");
const codexConfigDir = process.env.CODEX_SHARED_CONFIG_DIR ?? "/codex-config";
const runtimeBrokerUrl = process.env.RUNTIME_BROKER_URL ?? "http://runtime-broker:8090";
const runtimeBrokerToken = process.env.RUNTIME_BROKER_TOKEN ?? null;
const hostControllerUrl = process.env.MANOR_HOST_CONTROLLER_URL ?? null;
const hostControllerToken = process.env.MANOR_HOST_CONTROLLER_TOKEN ?? null;
const hotReloadEnabled = process.env.BUTLER_HOT_RELOAD === "1";
const publicPort = Number(process.env.BUTLER_PUBLIC_PORT ?? port);
const previewLeaseTtlMs = Number(process.env.MANOR_PREVIEW_LEASE_TTL_MS ?? `${30 * 60 * 1000}`);
const stackLeaseTtlMs = Number(process.env.MANOR_STACK_LEASE_TTL_MS ?? `${30 * 60 * 1000}`);
const serviceLeaseTtlMs = Number(process.env.MANOR_SERVICE_LEASE_TTL_MS ?? `${30 * 60 * 1000}`);
const leaseReapGraceMs = Number(process.env.MANOR_LEASE_REAP_GRACE_MS ?? `${10 * 60 * 1000}`);
const leaseSweepIntervalMs = Number(process.env.MANOR_LEASE_SWEEP_INTERVAL_MS ?? "60000");
const artifactRetentionMs = Number(process.env.MANOR_ARTIFACT_RETENTION_MS ?? `${14 * 24 * 60 * 60 * 1000}`);
const artifactSweepIntervalMs = Number(process.env.MANOR_ARTIFACT_SWEEP_INTERVAL_MS ?? `${60 * 60 * 1000}`);
const artifactsDir = path.resolve(process.env.MANOR_ARTIFACTS_DIR ?? "/artifacts");
const imageReferenceDir = process.env.MANOR_IMAGE_REFERENCE_DIR ?? path.resolve(process.cwd(), "../artifacts/manor-images");
const fileReferenceDir = process.env.MANOR_FILE_REFERENCE_DIR ?? path.join(artifactsDir, "manor-files");
const jsonBodyLimit = process.env.MANOR_UPLOAD_JSON_LIMIT ?? "64mb";
const imageUploadBinaryLimit = process.env.MANOR_IMAGE_UPLOAD_BINARY_LIMIT ?? `${Math.ceil(MAX_IMAGE_BYTES / (1024 * 1024))}mb`;
const fileUploadBinaryLimit = process.env.MANOR_FILE_UPLOAD_BINARY_LIMIT ?? `${Math.ceil(MAX_FILE_BYTES / (1024 * 1024))}mb`;
const previewAnnotationSecret = crypto.randomBytes(32).toString("hex");

const uiStatePath = path.join(stateDir, "butler-ui.json"); const scratchPadStatePath = path.join(stateDir, "scratch-pad.json");
const pairStatePath = path.join(stateDir, "butler-pairs-v2.json");
const sessionDir = path.join(stateDir, "pi-sessions");
const pairSessionDir = path.join(stateDir, "pi-pair-sessions");
const staticDir = path.resolve(process.cwd(), "dist/web"); const indexTemplatePath = path.resolve(process.cwd(), "index.html");
const settingsService = new ManorSettingsService(defaultManorSettingsPath(stateDir)); await settingsService.load(); setActiveManorSettingsService(settingsService);

const store = new ButlerStateStore(uiStatePath, {
  previewLeaseTtlMs,
  stackLeaseTtlMs,
  serviceLeaseTtlMs,
  leaseReapGraceMs,
  artifactRetentionMs
});
await store.load();
const pairStore = new PairStore(pairStatePath, store);
await pairStore.load();
let recoveredRetiredWorkers = false;
for (const pair of pairStore.listSummaries()) {
  const predecessorThreadId = pair.worker?.handedOffFrom?.threadId ?? null;
  if (predecessorThreadId && store.markWorkerThreadRetired(predecessorThreadId)) recoveredRetiredWorkers = true;
}
if (recoveredRetiredWorkers) await store.flushSave();
const scratchPadStore = new ScratchPadStore(scratchPadStatePath);
await scratchPadStore.load();
const serviceTemplateRegistry = new ServiceTemplateRegistry(path.join(stateDir, "service-templates.json"));
await serviceTemplateRegistry.load();
const { imageStore, fileStore, referenceMutations } = await loadReferenceStores({ artifactsDir, imageReferenceDir, fileReferenceDir });
const runtimeBroker = new RuntimeBrokerClient(runtimeBrokerUrl, runtimeBrokerToken);
const hostController = new HostControllerClient(hostControllerUrl, hostControllerToken);
let runtimeAccess!: RuntimeServerAccess;
let sseHub!: ButlerSseHub;
const selfImprovementRequests = new SelfImprovementRequestState(path.join(stateDir, "self-improvement-requests.json"), () => sseHub?.schedule(), (error) => console.error("Self-improvement queue save failed", error));
await selfImprovementRequests.load();
configureSelfImprovementRequestState(selfImprovementRequests);
const piAuthPath = path.join(piAgentDir, "auth.json"); const workerPiAuthPath = path.join(workerPiAgentDir, "auth.json"); const codexAuthPath = path.join(codexHomeDir, "auth.json");
const modelUsageStore = createModelUsageStore({ stateDir, butlerSessionRoots: [sessionDir, pairSessionDir], workerPiSessionRoot, codexHomeDir, piAuthPath });
const modelTasks = new ManorModelTaskRunner({ stateDir, codexHomeDir, piAuthPath }); const visionInspection = new VisionInspectionService({ imageStore, piAuthPath });
const sessionTitleGenerator = new ManorSessionTitleGenerator({
  ...readSessionTitleConfig(),
  runner: async (input) => modelTasks.runText({ purpose: "session title", ...input })
});
const { memoryReview, memoryScheduler, memoryPromotion, memoryEmbeddings, memorySemanticEdges, applySettings: applyBackgroundSettings } = createBackgroundModelServices({
  store,
  stateDir,
  codexHomeDir,
  modelTasks
});
store.setMemoryUpdateObserver(memoryScheduler); const harnessService = new HarnessService({
  codexHomeDir,
  harnessRegistryPath,
  harnessAccessPath,
  stateDir,
  artifactsDir,
  store,
  runtimeBroker,
  serviceTemplateRegistry,
  memoryReview,
  memoryScheduler,
  visionInspection, inputActionAccess: { fileStore, imageStore, referenceMutations, outputsDir: process.env.MANOR_OUTPUTS_DIR ?? "/outputs" }
});
memoryReview.reviewPendingReportsAsync();
memoryScheduler.start();
memoryPromotion.start();
memoryEmbeddings.start();
memorySemanticEdges.start();
await harnessService.load();
await harnessService.reconcileThreadCapabilities(); const extensionUiBroker = new ExtensionUiBroker();
const piRpcWorkerClient = new PiRpcWorkerClient({
  store,
  piAuthPath: workerPiAuthPath,
  sessionRootDir: workerPiSessionRoot,
  cliPath: workerPiRpcCliPath,
  extensionDir: workerPiExtensionDir,
  manageSessionDirectories: workerPiRpcCliPath === null,
  codexHomeDir,
  butlerBaseUrl: workerButlerBaseUrl,
  onThreadCapabilityReady: async (threadId, cwd) => {
    await harnessService.ensureThreadCapability(threadId, cwd);
  },
  onThreadCapabilityRemoved: async (threadId) => {
    await harnessService.revokeThreadCapability(threadId);
  },
  onThreadDeleting: async (context) => {
    await cleanupThreadRuntimeResources(runtimeAccess, context);
  }, extensionUiBroker
});
const codexClient = new CodexAppServerClient(codexBaseUrl, store, codexHomeDir, {
  onThreadCapabilityReady: async (threadId, cwd) => {
    await harnessService.ensureThreadCapability(threadId, cwd);
  },
  onThreadDeleting: async (context) => {
    await cleanupThreadRuntimeResources(runtimeAccess, context);
  },
  onRuntimeCleanupError: (threadId, message) => {
    sseHub.broadcastToast(`Thread cleanup failed for ${threadId.slice(0, 8)}: ${message}`, "error", 6000);
  },
  memoryScheduler,
  onThreadCapabilityRemoved: async (threadId) => {
    await harnessService.revokeThreadCapability(threadId);
  },
  artifactsDir,
  authTokenFile: codexAppServerAuthTokenFile
});
const skillsService = new SkillsService({ butlerPiAgentDir: piAgentDir, workerPiAgentDir, workerCodexHomeDir: codexHomeDir, workspaceRoot: process.env.WORKER_REPOS_ROOT ?? "/repos", listCodexSkills: (cwd) => codexClient.listSkills(cwd) }); function buildOperatorPromptSuffix(): string | null {
  const name = getActiveManorSettings().overview.operatorName.trim();
  return name ? `Refer to the operator as ${name}.` : null;
}

const butlerAgent = new ButlerAgentService({
  store,
  memoryScheduler,
  codexClient,
  piRpcWorkerClient,
  hostController,
  runtimeBroker,
  serviceTemplateRegistry,
  piAuthPath,
  codexAuthPath,
  codexConfigDir,
  sessionDir,
  imageStore,
  fileStore,
  visionInspection,
  artifactsDir, extensionUiBroker, skillsService,
  refreshRuntimeInventory: syncRuntimeInventory,
  systemPromptSuffix: buildOperatorPromptSuffix(),
  getButlerDefaults: () => {
    const lastUsed = pairStore.getLastUsedCompose();
    if (!lastUsed) return null;
    return {
      model: lastUsed.butlerModel ?? null,
      thinkingLevel: lastUsed.butlerThinkingLevel ?? null
    };
  },
  getWorkerAffinity: () => pairStore.getWorkerAffinity(),
  recordSuccessfulWorkerSelection: (selection) => pairStore.recordSuccessfulWorkerSelection(selection)
});
const pairSessions = new PairSessionManager({
  pairStore,
  store,
  codexClient,
  piRpcWorkerClient,
  skillsService, extensionUiBroker,
  hostController,
  runtimeBroker,
  serviceTemplateRegistry,
  imageStore,
  fileStore,
  visionInspection,
  piAuthPath,
  codexAuthPath,
  codexConfigDir,
  sessionRootDir: pairSessionDir,
  artifactsDir,
  refreshRuntimeInventory: syncRuntimeInventory,
  memoryScheduler,
  sessionTitleGenerator,
  getCodexAuthStatus: () => butlerAgent.getCodexAuthStatus(),
  onButlerPatch: (payload) => sseHub?.broadcastButlerPatch(payload), onWorkerThreadRefreshed: (threadId) => sseHub?.broadcastWorkerThreadRefreshed(threadId)
});
const automationScheduler = new SessionAutomationScheduler({ pairStore, dispatch: (input) => pairSessions.runAutomation(input), onSkipped: (pairId, message) => pairSessions.postAutomationNotice(pairId, message) }); const modelInventoryRefresh = createProviderModelRefreshCoordinator({ pairSessions, piRpcWorkerClient, butlerAgent, scheduleSse: () => sseHub?.schedule() });
configureSelfImprovementPairCleanup(pairSessions);
let selfImprovementReconciliation = Promise.resolve();
const reconcileSelfImprovementAfterRestart = (canConcludeThreadMissing: (threadId: string) => boolean) => {
  const current = selfImprovementReconciliation.then(() =>
    reconcileInterruptedSelfImprovementRequests(selfImprovementRequests, store, pairStore, pairSessions, canConcludeThreadMissing)
  );
  selfImprovementReconciliation = current.catch((error) => {
    console.error(`Self-improvement restart recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return selfImprovementReconciliation;
};
codexClient.on("threadsSeeded", () => { void reconcileSelfImprovementAfterRestart(() => true); });

const applyManagedSettingsChange = createManorSettingsApplyHandler({ settingsService, applyBackgroundSettings, sessionTitleGenerator, piRpcWorkerClient, butlerAgent, pairSessions, store, codexClient, getSseHub: () => sseHub });
runtimeAccess = {
  artifactsDir,
  butlerAgent,
  codexClient,
  runtimeBroker,
  runtimeBrokerUrl,
  previewAnnotationSecret,
  scratchPadStore,
  serviceTemplateRegistry,
  store
};
sseHub = new ButlerSseHub(runtimeAccess);

await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(piAgentDir, { recursive: true }); await fs.mkdir(workerPiAgentDir, { recursive: true });
await fs.mkdir(workerPiSessionRoot, { recursive: true });

await butlerAgent.start();
codexClient.start();
await piRpcWorkerClient.start();
await reconcileSelfImprovementAfterRestart((threadId) => threadId.startsWith("pi-"));
await pairSessions.startSupervisedSessions(); automationScheduler.start(); const stopOllamaCloudModelRecovery = startOllamaCloudModelRecovery(modelInventoryRefresh);

const app = express();
const server = http.createServer(app);
const previewProxy = httpProxy.createProxyServer({
  changeOrigin: false,
  selfHandleResponse: true,
  ws: true
});
registerPreviewProxyResponseRewriter(previewProxy, runtimeAccess);

let viteDevServer: import("vite").ViteDevServer | null = null;
const imageUploadBinaryParser = express.raw({
  type: isBinaryUploadRequest,
  limit: imageUploadBinaryLimit
});
const fileUploadBinaryParser = express.raw({
  type: isBinaryUploadRequest,
  limit: fileUploadBinaryLimit
});

app.use(/^\/preview\/([^/]+)(\/.*)?$/, (request, response) => {
  const previewRoute = resolvePreviewRouteUrl(request.originalUrl);
  if (!previewRoute) {
    response.status(404).end();
    return;
  }

  proxyPreviewRoute(runtimeAccess, previewProxy, previewRoute, request, response);
});

app.use((request, response, next) => {
  const previewRoute = resolvePreviewRefererRouteUrl(
    request.originalUrl,
    request.headers.referer ?? request.headers.referrer
  );
  if (!previewRoute) {
    next();
    return;
  }

  proxyPreviewRoute(runtimeAccess, previewProxy, previewRoute, request, response);
});

app.use(express.json({ limit: jsonBodyLimit, type: shouldParseJsonRequest }));

const { applyServiceStartedPoliciesForServer } = registerProjectArtifactPolicyRoutes({
  app,
  artifactsDir,
  store,
  runtimeBroker
});
registerServerAssetRoutes({
  app,
  artifactsDir,
  store,
  pairStore,
  imageStore,
  fileStore,
  referenceMutations,
  imageUploadBinaryParser,
  fileUploadBinaryParser
});

if (hotReloadEnabled) {
  const { createServer } = await import("vite");
  viteDevServer = await createServer({
    root: process.cwd(),
    appType: "custom",
    server: {
      middlewareMode: true,
      host: "0.0.0.0",
      watch: {
        usePolling: false
      },
      hmr: {
        protocol: "ws",
        clientPort: publicPort
      }
    }
  });
}

store.on("change", () => {
  pairStore.syncWorkerReports();
  sseHub.schedule();
});
pairStore.on("change", () => sseHub.schedule());
scratchPadStore.on("change", () => sseHub.schedule());
codexClient.on("change", () => sseHub.schedule());
codexClient.on("threadPatch", (payload) => sseHub.broadcastThreadPatch(payload));
piRpcWorkerClient.on("change", () => sseHub.schedule());
piRpcWorkerClient.on("threadPatch", (payload) => sseHub.broadcastThreadPatch(payload));
butlerAgent.on("change", () => sseHub.schedule());
butlerAgent.on("butlerPatch", (payload) => sseHub.broadcastButlerPatch(payload));

app.get("/api/health", (_request, response) => {
  response.json({
	    ok: true,
	    codex: codexClient.getConnectionState(),
	    piRpcWorker: piRpcWorkerClient.getConnectionState(),
	    butler: butlerAgent.getSnapshot()
	  });
});

app.get("/livez", (_request, response) => {
  response.json({ ok: true, version: MANOR_VERSION });
});

app.get("/api/bootstrap", (_request, response) => {
  response.json(currentBootstrapSnapshot(runtimeAccess));
});

app.get("/api/telemetry/live-stream", (_request, response) => {
  response.json(sseHub.getLiveStreamTelemetrySnapshot());
});

app.post("/api/telemetry/live-stream", (request, response) => {
  const accepted = sseHub.recordLiveStreamTelemetryAcks(request.body?.acks ?? request.body);
  response.json({ ok: true, accepted });
});

app.get("/api/shell", (_request, response) => {
  response.json(store.getShellSnapshot(butlerAgent.getShellSnapshot(), {
    ...codexClient.getConnectionState(),
    auth: butlerAgent.getCodexAuthStatus()
  }));
});

registerDeviceAuthRoutes(app, { piAgentDir, codexHomeDir }); registerSkillsRoutes(app, skillsService, { onMutation: (environment) => { if (environment !== "butler-pi") return; void butlerAgent.reloadResources().catch((error) => console.error("Butler skill reload failed", error)); pairSessions.scheduleButlerSkillsReload(); } });

app.get("/api/runtime", async (_request, response) => {
  try {
    await syncRuntimeInventory();
  } catch (error) {
    console.error("Runtime inventory sync failed", error);
  }

  response.json(store.getRuntimeSnapshot(serviceTemplateRegistry.list()));
});

app.get("/api/threads/:threadId", (request, response) => {
  const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  const thread = store.getThreadDetail(threadId);
  if (!thread) {
    response.status(404).json({ error: "Thread not found" });
    return;
  }

  response.json({ thread });
});

registerThreadArtifactRoutes({
  app,
  artifactsDir,
  codexHomeDir,
  store
});
registerScratchPadRoutes({
  app,
  scratchPadStore,
  store,
  codexClient,
  piRpcWorkerClient,
  butlerAgent,
  artifactsDir,
  imageStore,
  fileStore
});
registerPreviewAnnotationRoutes({
  app,
  imageStore,
  previewAnnotationSecret,
  runtimeBroker,
  runtimeBrokerToken,
  sseHub,
  store
});
registerPairRoutes({ app, pairSessions });
registerExtensionUiRoutes({ app, pairStore, broker: extensionUiBroker }); registerWorkerSessionControlRoutes({ app, pairStore, piRpcWorkerClient }); registerButlerSessionControlRoutes({ app, pairSessions });
registerManorSettingsRoutes({ app, settingsService, store, codexClient, piRpcWorkerClient, butlerAgent, onSettingsChanged: applyManagedSettingsChange, refreshModelInventories: () => modelInventoryRefresh.request() });
registerModelUsageRoutes(app, modelUsageStore);
registerSelfImprovementRoutes({
  app,
  requests: selfImprovementRequests,
  hostController,
  store,
  codexClient,
  piRpcWorkerClient,
  getCodexAuthStatus: () => butlerAgent.getCodexAuthStatus(),
  getWorkerAffinity: () => butlerAgent.getWorkerAffinity(),
  recordSuccessfulWorkerSelection: (selection) => butlerAgent.recordSuccessfulWorkerSelection(selection),
  pairSessions,
  imageStore,
  fileStore,
  artifactsDir
});

app.get("/api/memory/jobs/:threadId", (request, response) => {
  const threadId = typeof request.params.threadId === "string" ? request.params.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  const jobMemory = store.getJobMemory(threadId);
  if (!jobMemory) {
    response.status(404).json({ error: "Job memory not found" });
    return;
  }

  response.json({ jobMemory });
});

app.get("/api/memory/projects/:projectId", (request, response) => {
  const projectId = typeof request.params.projectId === "string" ? request.params.projectId : "";
  if (!projectId) {
    response.status(400).json({ error: "projectId is required" });
    return;
  }

  response.json({
    projectMemory: store.getProjectMemory(projectId),
    pendingPromotionCandidates: store.listPendingPromotionCandidates(projectId)
  });
});

app.get("/api/memory/retrieve", async (request, response) => {
  const projectId = typeof request.query.projectId === "string" ? request.query.projectId : null;
  const threadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  const query = typeof request.query.query === "string" ? request.query.query : null;
  const limitRaw = typeof request.query.limit === "string" ? Number(request.query.limit) : null;
  const includeGlobal = request.query.includeGlobal === "1" || request.query.includeGlobal === "true";
  const includeProvenance = request.query.includeProvenance === "1" || request.query.includeProvenance === "true";

  response.json({
    retrieval: await retrieveButlerMemoryWithEmbeddings(store, {
      projectId,
      threadId,
      query,
      limit: Number.isFinite(limitRaw) ? limitRaw : null,
      includeGlobal,
      includeProvenance
    })
  });
});

app.get("/api/memory/diagnostics", (request, response) => {
  const projectId = typeof request.query.projectId === "string" ? request.query.projectId : null;
  const threadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  const from = typeof request.query.from === "string" ? request.query.from : null;
  const to = typeof request.query.to === "string" ? request.query.to : null;
  const includeSamples = request.query.includeSamples === "1" || request.query.includeSamples === "true";
  const sampleLimitRaw = typeof request.query.sampleLimit === "string" ? Number(request.query.sampleLimit) : null;

  response.json({
    diagnostics: buildMemoryDiagnostics(store, {
      projectId,
      threadId,
      from,
      to,
      includeSamples,
      sampleLimit: Number.isFinite(sampleLimitRaw) ? sampleLimitRaw : null
    })
  });
});

app.get("/api/memory/debug/traces", (request, response) => {
  const kind = request.query.kind === "review" || request.query.kind === "synthesis" ? request.query.kind : null;
  const status = request.query.status === "completed" || request.query.status === "failed" || request.query.status === "skipped" ? request.query.status : null;
  const projectId = typeof request.query.projectId === "string" ? request.query.projectId : null;
  const threadId = typeof request.query.threadId === "string" ? request.query.threadId : null;
  const from = typeof request.query.from === "string" ? request.query.from : null;
  const to = typeof request.query.to === "string" ? request.query.to : null;
  const limitRaw = typeof request.query.limit === "string" ? Number(request.query.limit) : null;
  response.json({ traces: listMemoryDebugTraces(store, { kind, status, projectId, threadId, from, to, limit: Number.isFinite(limitRaw) ? limitRaw : null }) });
});

app.get("/api/memory/debug/traces/:traceId", (request, response) => {
  const trace = getMemoryDebugTrace(store, request.params.traceId);
  if (!trace) {
    response.status(404).json({ error: "Memory debug trace not found" });
    return;
  }
  response.json({ trace });
});

app.get("/api/memory/graph/search", (request, response) => { const projectId = typeof request.query.projectId === "string" ? request.query.projectId : null; const threadId = typeof request.query.threadId === "string" ? request.query.threadId : null; const query = typeof request.query.query === "string" ? request.query.query : null; const limitRaw = typeof request.query.limit === "string" ? Number(request.query.limit) : null; response.json({ retrieval: store.searchMemoryGraph({ projectId, threadId, query, limit: Number.isFinite(limitRaw) ? limitRaw : null }) }); });

app.post("/api/memory/promotions/resolve", (request, response) => {
  const candidateId = typeof request.body?.candidateId === "string" ? request.body.candidateId.trim() : "";
  const accepted = typeof request.body?.accepted === "boolean" ? request.body.accepted : null;
  if (!candidateId || accepted === null) {
    response.status(400).json({ error: "candidateId and accepted are required" });
    return;
  }

  const candidate = store.resolvePromotionCandidate(candidateId, accepted);
  if (!candidate) {
    response.status(404).json({ error: "Promotion candidate not found" });
    return;
  }
  memoryScheduler.observePromotionResolved({
    candidateId: candidate.id,
    accepted,
    projectId: candidate.projectId,
    projectLabel: candidate.projectLabel,
    threadId: candidate.threadId,
    summary: candidate.summary,
    details: candidate.details
  });

  response.json({
    ok: true,
    candidate,
    projectMemory: store.getProjectMemory(candidate.projectId)
  });
});

app.post("/api/memory/butler/remember", (request, response) => {
  const summary = typeof request.body?.summary === "string" ? request.body.summary.trim() : "";
  const details = typeof request.body?.details === "string" && request.body.details.trim() ? request.body.details.trim() : null;
  const sourceMessageId = typeof request.body?.sourceMessageId === "string" && request.body.sourceMessageId.trim() ? request.body.sourceMessageId.trim() : null;
  const tags = Array.isArray(request.body?.tags) ? request.body.tags : [];
  if (!summary) {
    response.status(400).json({ error: "summary is required" });
    return;
  }

  const entry = store.recordButlerMemory({
    summary,
    details,
    source: "manual_chat_save",
    sourceMessageId,
    tags
  });
  response.json({ ok: true, entry });
});

app.get("/api/memory/butler", (request, response) => {
  const projectId = typeof request.query.projectId === "string" && request.query.projectId ? request.query.projectId : null;
  const query = typeof request.query.query === "string" ? request.query.query : null;
  let entries = store.listButlerMemory();
  if (projectId) {
    entries = entries.filter((entry) => entry.tags.includes(`project:${projectId}`));
  }
  if (query && query.trim()) {
    const needle = query.trim().toLowerCase();
    entries = entries.filter(
      (entry) =>
        entry.summary.toLowerCase().includes(needle) ||
        (entry.details ? entry.details.toLowerCase().includes(needle) : false) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  }
  response.json({ entries });
});

app.get("/api/memory/projects", (request, response) => {
  const projectId = typeof request.query.projectId === "string" && request.query.projectId ? request.query.projectId : null;
  const query = typeof request.query.query === "string" ? request.query.query : null;
  let projects = store.listProjectMemories();
  if (projectId) {
    projects = projects.filter((memory) => memory.projectId === projectId);
  }
  if (query && query.trim()) {
    const needle = query.trim().toLowerCase();
    projects = projects.filter(
      (memory) =>
        memory.projectLabel.toLowerCase().includes(needle) ||
        (memory.summary ? memory.summary.toLowerCase().includes(needle) : false) ||
        memory.entries.some(
          (entry) =>
            entry.summary.toLowerCase().includes(needle) ||
            (entry.details ? entry.details.toLowerCase().includes(needle) : false)
        )
    );
  }
  response.json({ projects });
});

app.get("/api/memory/jobs", (request, response) => {
  const projectId = typeof request.query.projectId === "string" && request.query.projectId ? request.query.projectId : null;
  const query = typeof request.query.query === "string" ? request.query.query : null;
  let jobs = store.listJobMemories(projectId);
  if (query && query.trim()) {
    const needle = query.trim().toLowerCase();
    jobs = jobs.filter((memory) => {
      if (memory.latestCheckpoint && memory.latestCheckpoint.toLowerCase().includes(needle)) return true;
      if (memory.nextAction && memory.nextAction.toLowerCase().includes(needle)) return true;
      if (memory.operatorGoal && memory.operatorGoal.toLowerCase().includes(needle)) return true;
      if (memory.requestedTask && memory.requestedTask.toLowerCase().includes(needle)) return true;
      if (memory.decisions.some((decision) => decision.summary.toLowerCase().includes(needle))) return true;
      if (memory.notes.some((note) => note.toLowerCase().includes(needle))) return true;
      if (memory.entries.some((entry) => entry.summary.toLowerCase().includes(needle))) return true;
      return false;
    });
  }
  response.json({ jobs });
});

app.delete("/api/memory/butler/:id", (request, response) => {
  const id = request.params.id;
  const ok = store.deleteButlerMemory(id);
  if (!ok) {
    response.status(404).json({ error: "Butler memory entry not found" });
    return;
  }
  response.json({ ok: true });
});

app.delete("/api/memory/jobs/:threadId/entries/:entryId", (request, response) => {
  const { threadId, entryId } = request.params;
  const ok = store.deleteJobMemoryEntry(threadId, entryId);
  if (!ok) {
    response.status(404).json({ error: "Job memory entry not found" });
    return;
  }
  response.json({ ok: true });
});

app.delete("/api/memory/projects/:projectId/entries/:entryId", (request, response) => {
  const { projectId, entryId } = request.params;
  const ok = store.deleteProjectMemoryEntry(projectId, entryId);
  if (!ok) {
    response.status(404).json({ error: "Project memory entry not found" });
    return;
  }
  response.json({ ok: true });
});

app.get("/api/chat/history", (request, response) => {
  const beforeRaw = Array.isArray(request.query.before) ? request.query.before[0] : request.query.before;
  const limitRaw = Array.isArray(request.query.limit) ? request.query.limit[0] : request.query.limit;
  const before = typeof beforeRaw === "string" && beforeRaw.length > 0 ? Number(beforeRaw) : null;
  const limit = typeof limitRaw === "string" && limitRaw.length > 0 ? Number(limitRaw) : 250;

  if (before !== null && !Number.isFinite(before)) {
    response.status(400).json({ error: "before must be a number" });
    return;
  }

  if (!Number.isFinite(limit)) {
    response.status(400).json({ error: "limit must be a number" });
    return;
  }

  response.json(butlerAgent.getMessagePage(before, limit));
});

for (const route of ["/api/harness/action", "/api/codex-harness/action"]) {
  app.post(route, async (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const action = typeof request.body?.action === "string" ? request.body.action : "";
    const params = request.body?.params && typeof request.body.params === "object" ? (request.body.params as Record<string, unknown>) : {};

    if (!token || !action) {
      response.status(400).json({ error: "token and action are required" });
      return;
    }

    try {
      const result = await harnessService.handleAction({ token, action, params });
      response.json({ ok: true, ...result });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

app.get("/api/events", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write("retry: 1000\n\n");
  sseHub.addClient(response, resolveSseStateChannels(request.query.state));
  sseHub.sendInitialEvents(response);
  const heartbeat = setInterval(() => {
    sseHub.writeHeartbeat(response);
  }, sseHub.heartbeatMs);

  const cleanup = () => {
    clearInterval(heartbeat);
    sseHub.removeClient(response);
  };

  request.on("close", cleanup);
  request.on("error", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);
});



app.post("/api/chat/messages", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const imageReferenceIds = readImageReferenceIds(request.body);
  const fileReferenceIds = readFileReferenceIds(request.body);
  const inputItems = Array.isArray(request.body?.inputItems) ? request.body.inputItems : [];
  const mode = request.body?.mode === "steer" ? "steer" : "queue";
  if (!text.trim() && imageReferenceIds.length === 0 && fileReferenceIds.length === 0 && inputItems.length === 0) {
    response.status(400).json({ error: "text, imageReferenceIds, fileReferenceIds, or inputItems is required" });
    return;
  }

  try {
    const referencePromptText = buildReferencePromptText({
      text,
      imageStore,
      imageReferenceIds,
      fileStore,
      fileReferenceIds,
      includeIds: true,
      includeFilePaths: true
    });
    const inputItemsPromptText = buildComposerInputItemsPrompt(inputItems);
    const promptText = [referencePromptText, inputItemsPromptText].filter(Boolean).join("\n\n");
    const referenceCount = imageReferenceIds.length + fileReferenceIds.length;
    const displayText = text.trim() || (referenceCount > 0
      ? referenceCount === 1 ? "Attached 1 reference file." : `Attached ${referenceCount} reference files.`
      : inputItemsPromptText.trim() || promptText);
    butlerAgent.prompt(promptText, imageReferenceIds, { mode, displayText, fileReferenceIds });
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat/operator-question-answer", async (request, response) => {
  const messageId = typeof request.body?.messageId === "string" ? request.body.messageId.trim() : "";
  const questionId = typeof request.body?.questionId === "string" ? request.body.questionId.trim() : "";
  const optionId = typeof request.body?.optionId === "string" ? request.body.optionId.trim() : "";
  const freeformText = typeof request.body?.freeformText === "string" ? request.body.freeformText.trim() : "";
  if (!messageId || !questionId || Boolean(optionId) === Boolean(freeformText)) {
    response.status(400).json({ error: "messageId, questionId, and exactly one answer are required" });
    return;
  }

  try {
    const result = await butlerAgent.answerOperatorQuestion({ messageId, questionId, optionId: optionId || undefined, freeformText: freeformText || undefined });
    response.status(202).json({ ok: true, complete: result.complete, queued: result.queued, question: result.message.question });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat/stop", async (_request, response) => {
  try {
    const stopped = await butlerAgent.stopPrompt();
    response.json({ ok: true, stopped });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat/settings", async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model : "";
  const provider = typeof request.body?.provider === "string" ? request.body.provider : "";
  const thinkingLevel = typeof request.body?.thinkingLevel === "string" ? request.body.thinkingLevel : "medium";
  if (!model) {
    response.status(400).json({ error: "model is required" });
    return;
  }

  try {
    await butlerAgent.updateComposeSettings(provider, model, thinkingLevel);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

registerManorRestartRoutes(app, butlerAgent);

app.post("/api/chat/clear", async (_request, response) => {
  try {
    await butlerAgent.clearChat();
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/chat/delete-from", async (request, response) => {
  const messageId = typeof request.body?.messageId === "string" ? request.body.messageId : "";
  if (!messageId) {
    response.status(400).json({ error: "messageId is required" });
    return;
  }

  try {
    await butlerAgent.deleteChatFromMessage(messageId);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/composer/suggestions", async (request, response) => {
  const trigger = request.query.trigger === "$" ? "$" : request.query.trigger === "@" ? "@" : null;
  const query = typeof request.query.q === "string" ? request.query.q : "";
  const cwd = typeof request.query.cwd === "string" ? request.query.cwd : null;
  const threadId = typeof request.query.threadId === "string" ? request.query.threadId : null;

  if (!trigger) {
    response.status(400).json({ error: "trigger is required" });
    return;
  }

  try {
    const suggestions = await codexClient.listComposerSuggestions({ trigger, query, cwd, threadId });
    response.json({ suggestions });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/messages", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const imageReferenceIds = readImageReferenceIds(request.body);
  const fileReferenceIds = readFileReferenceIds(request.body);
  const inputItems = Array.isArray(request.body?.inputItems) ? request.body.inputItems : [];
  if (!threadId || (!text.trim() && imageReferenceIds.length === 0 && fileReferenceIds.length === 0)) {
    response.status(400).json({ error: "threadId plus text, imageReferenceIds, or fileReferenceIds is required" });
    return;
  }

  try {
    await runSerializedJobMutation(threadId, async () => {
      const requestedAt = Date.now();
      const directInput = { threadId, text, imageReferenceIds, fileReferenceIds, inputItems, requestedAt };
      const reservation = await butlerAgent.reserveDirectCodexMessage(directInput);
      let sent = false;
      try {
        await butlerAgent.notifyDirectCodexMessage({ ...directInput, callbackAlreadyRegistered: true }, reservation);
        const workerInput = buildWorkerInputWithReferences({ text, imageStore, imageReferenceIds, fileStore, fileReferenceIds, extraInputItems: inputItems });
        workerInput.push({ type: "text", text: directWorkerDispatchMarker(threadId, requestedAt) });
        const dispatch = await sendWorkerMessage(
          { store, codexClient, piRpcWorkerClient },
          threadId,
          workerInput
        );
        sent = true; await butlerAgent.markPendingChatCallbackDispatched(threadId, requestedAt, dispatch.turnId);
      } catch (error) {
        if (!sent) await settleFailedDirectWorkerDispatch(error, () => butlerAgent.markPendingChatCallbackDispatched(threadId, requestedAt, null), () => butlerAgent.rollbackDirectCodexMessage(threadId, requestedAt, reservation));
        throw error;
      }
    });
    response.status(202).json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/stop", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    const stopped = await stopWorkerThread({ store, codexClient, piRpcWorkerClient }, threadId);
    response.json({ ok: true, stopped });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/settings", async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model : "";
  const effort = typeof request.body?.effort === "string" ? request.body.effort : null;
  if (!model) {
    response.status(400).json({ error: "model is required" });
    return;
  }

  try {
    await updateUnifiedWorkerCompose({
      store,
      codexClient,
      piRpcWorkerClient,
      getCodexAuthStatus: () => butlerAgent.getCodexAuthStatus(),
      getWorkerAffinity: () => butlerAgent.getWorkerAffinity()
    }, { model, effort: effort as never });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/:threadId/settings", async (request, response) => {
  const threadId = request.params.threadId;
  const effort = typeof request.body?.effort === "string" ? request.body.effort : null;
  if (!threadId || !effort) {
    response.status(400).json({ error: "threadId and effort are required" });
    return;
  }

  try {
    await updateWorkerThreadEffort({ store, codexClient, piRpcWorkerClient }, threadId, effort as never);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/threads/supervision", (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  const rawLimit = request.body?.maxButlerTurns;

  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  const maxButlerTurns =
    rawLimit === null || rawLimit === "null"
      ? null
      : typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.floor(rawLimit)
        : null;

  const supervision = store.setThreadSupervisionLimit(threadId, maxButlerTurns);
  response.json({ ok: true, supervision });
});

app.post("/api/threads/delete", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  void runSerializedJobMutation(threadId, async () => {
    try {
      await deleteWorkerThread({ store, codexClient, piRpcWorkerClient }, threadId);
    } finally {
      if (!store.getThread(threadId)) await butlerAgent.removeExternalWorkerDelegation(threadId);
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sseHub.broadcastToast(`Thread cleanup failed: ${message}`, "error", 6000);
  });

  response.status(202).json({ ok: true, started: true });
});

app.post("/api/threads/delete-all", async (_request, response) => {
  const threadIds = store.listThreads().map((thread) => thread.id);
  void runSerializedJobMutations(threadIds, async () => {
    try {
      await deleteAllWorkerThreads({ store, codexClient, piRpcWorkerClient });
    } finally {
      await Promise.all(threadIds
        .filter((threadId) => !store.getThread(threadId))
        .map((threadId) => butlerAgent.removeExternalWorkerDelegation(threadId)));
    }
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sseHub.broadcastToast(`Bulk thread cleanup failed: ${message}`, "error", 6000);
  });

  response.status(202).json({ ok: true, started: true });
});

app.post("/api/windows/open", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    await loadWorkerThread({ store, codexClient, piRpcWorkerClient }, threadId);
    store.openWindow(threadId);
    response.json({ ok: true });
  } catch (error) {
    if (shouldAllowLocalThreadWindow(runtimeAccess, threadId, error)) {
      store.openWindow(threadId);
      response.json({ ok: true, localFallback: true });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspace/focus", (_request, response) => {
  store.focusButler();
  response.json({ ok: true });
});

app.post("/api/windows/focus", async (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  try {
    await loadWorkerThread({ store, codexClient, piRpcWorkerClient }, threadId);
    store.focusWindow(threadId);
    response.json({ ok: true });
  } catch (error) {
    if (shouldAllowLocalThreadWindow(runtimeAccess, threadId, error)) {
      store.focusWindow(threadId);
      if (store.getShellSnapshot(butlerAgent.getShellSnapshot(), {
        ...codexClient.getConnectionState(),
        auth: butlerAgent.getCodexAuthStatus()
      }).codex.windows.some((window) => window.threadId === threadId)) {
        response.json({ ok: true, localFallback: true });
        return;
      }
      store.openWindow(threadId);
      response.json({ ok: true, localFallback: true });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/windows/close", (request, response) => {
  const threadId = typeof request.body?.threadId === "string" ? request.body.threadId : "";
  if (!threadId) {
    response.status(400).json({ error: "threadId is required" });
    return;
  }

  store.closeWindow(threadId);
  response.json({ ok: true });
});

registerRuntimeResourceRoutes({
  app,
  runtimeAccess,
  runtimeBroker,
  serviceTemplateRegistry,
  store,
  applyServiceStartedPoliciesForServer
});

registerDesktopSessionRoutes(app, runtimeAccess);

let leaseSweepInFlight = false;
let artifactSweepInFlight = false;
let previewReconcileInFlight = false;
let serviceReconcileInFlight = false;
let stackReconcileInFlight = false;
let runtimeInventorySyncInFlight: Promise<void> | null = null;

async function syncRuntimeInventory(): Promise<void> {
  if (runtimeInventorySyncInFlight) {
    await runtimeInventorySyncInFlight;
    return;
  }

  runtimeInventorySyncInFlight = (async () => {
    await reconcileStackLeases();
    await reconcilePreviewLeases();
    await reconcileServiceLeases();
    await reconcileDesktopSessions(runtimeAccess);
  })();

  try {
    await runtimeInventorySyncInFlight;
  } finally {
    runtimeInventorySyncInFlight = null;
  }
}

async function sweepExpiredLeases(): Promise<void> {
  if (leaseSweepInFlight) {
    return;
  }

  leaseSweepInFlight = true;

  try {
    await syncRuntimeInventory();
    const expired = store.listExpiredLeaseIds();

    for (const stackId of expired.stacks) {
      try {
        const stack = store.getStackLease(stackId);
        await runtimeBroker.stopStack(stackId, { dropVolumes: Boolean(stack?.retainsVolumes) });
      } catch {
        // ignore broker cleanup failures and still evict the local lease
      }
      removeStackArtifactsFromStore(runtimeAccess, stackId);
    }

    for (const leaseId of expired.previews) {
      try {
        await runtimeBroker.stopLease(leaseId);
      } catch {
        // ignore broker cleanup failures and still evict the local lease
      }
      store.removePreviewLease(leaseId);
    }

    for (const serviceId of expired.services) {
      const lease = store.getServiceLease(serviceId);
      if (!lease) {
        continue;
      }

      if (lease.runtimeKind === "container") {
        try {
          await runtimeBroker.stopService(serviceId);
        } catch {
          // ignore broker cleanup failures and still evict the local lease
        }
      }

      store.removeServiceLease(serviceId);
    }
  } finally {
    leaseSweepInFlight = false;
  }
}

const leaseReaper = setInterval(() => {
  void sweepExpiredLeases().catch((error) => {
    console.error("Lease sweep failed", error);
  });
}, leaseSweepIntervalMs);

const runtimeCleanupWorker = setInterval(() => {
  void codexClient.processPendingCleanupTasks().catch((error) => {
    console.error("Runtime cleanup worker failed", error);
  });
}, leaseSweepIntervalMs);

void sweepExpiredLeases().catch((error) => {
  console.error("Initial lease sweep failed", error);
});

void codexClient.processPendingCleanupTasks().catch((error) => {
  console.error("Initial runtime cleanup sweep failed", error);
});

async function sweepExpiredArtifacts(): Promise<void> {
  if (artifactSweepInFlight) {
    return;
  }

  artifactSweepInFlight = true;
  try {
    const now = Date.now();
    for (const proof of store.listPreviewProofs()) {
      for (const artifact of proof.verification.artifacts) {
        if (!artifact.filePath || artifact.availability !== "available") {
          continue;
        }

        const retainedUntilAt =
          typeof artifact.retainedUntilAt === "number" && Number.isFinite(artifact.retainedUntilAt)
            ? artifact.retainedUntilAt
            : proof.verification.checkedAt + artifactRetentionMs;

        if (retainedUntilAt <= now) {
          await fs.rm(artifact.filePath, { force: true }).catch(() => {});
          store.markPreviewProofArtifactExpired(artifact.filePath, now);
          await pruneEmptyArtifactParents(artifactsDir, artifact.filePath);
          continue;
        }

        const exists = await fs
          .access(artifact.filePath)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          store.markPreviewProofArtifactMissing(artifact.filePath, now);
        }
      }
    }
  } finally {
    artifactSweepInFlight = false;
  }
}

const artifactReaper = setInterval(() => {
  void sweepExpiredArtifacts().catch((error) => {
    console.error("Artifact sweep failed", error);
  });
}, artifactSweepIntervalMs);

void sweepExpiredArtifacts().catch((error) => {
  console.error("Initial artifact sweep failed", error);
});

async function reconcileStackLeases(): Promise<void> {
  if (stackReconcileInFlight) {
    return;
  }

  stackReconcileInFlight = true;
  try {
    const brokerStacks = await runtimeBroker.listStacks();
    const brokerStackIds = new Set(brokerStacks.map((stack) => stack.id));
    const storedStacks = store.listStackLeases().filter((lease) => lease.status !== "stopped");

    for (const lease of storedStacks) {
      if (!brokerStackIds.has(lease.id)) {
        removeStackArtifactsFromStore(runtimeAccess, lease.id);
      }
    }

    for (const stack of brokerStacks) {
      store.upsertStackLease(stack);
    }
  } catch (error) {
    console.error("Stack reconcile failed", error);
  } finally {
    stackReconcileInFlight = false;
  }
}

async function reconcilePreviewLeases(): Promise<void> {
  if (previewReconcileInFlight) {
    return;
  }

  previewReconcileInFlight = true;
  try {
    const brokerLeases = await runtimeBroker.listLeases();
    const brokerLeaseIds = new Set(brokerLeases.map((lease) => lease.id));
    const storedLeases = store.listPreviewLeases().filter((lease) => lease.status !== "stopped");

    preserveMissingPreviewLeaseTombstones(store, brokerLeaseIds, storedLeases);

    for (const lease of brokerLeases) {
      store.upsertPreviewLease(lease);
    }
  } catch (error) {
    console.error("Preview reconcile failed", error);
  } finally {
    previewReconcileInFlight = false;
  }
}

async function reconcileServiceLeases(): Promise<void> {
  if (serviceReconcileInFlight) {
    return;
  }

  serviceReconcileInFlight = true;
  try {
    const brokerServices = await runtimeBroker.listServices();
    const brokerServiceIds = new Set(brokerServices.map((service) => service.id));
    const storedServices = store.listServiceLeases().filter((lease) => lease.status !== "stopped" && lease.runtimeKind === "container");

    for (const lease of storedServices) {
      if (!brokerServiceIds.has(lease.id)) {
        store.removeServiceLease(lease.id);
      }
    }

    for (const service of brokerServices) {
      const template = serviceTemplateRegistry.get(service.templateId);
      if (!template) {
        continue;
      }
      store.upsertServiceLease(
        toServiceLeaseView({
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
        })
      );
    }
  } catch (error) {
    console.error("Service reconcile failed", error);
  } finally {
    serviceReconcileInFlight = false;
  }
}

const runtimeReconciler = setInterval(() => {
  void syncRuntimeInventory().catch((error) => {
    console.error("Runtime reconcile failed", error);
  });
}, 5_000);

void syncRuntimeInventory().catch((error) => {
  console.error("Initial runtime reconcile failed", error);
});

app.use(/^\/(?:terminal|butler-terminal)(?:\/.*)?$/, (request, response) => {
  response
    .status(503)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Terminal unavailable</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0b1524;
        color: #e5eefc;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 34rem;
        padding: 1.5rem;
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }
      p {
        margin: 0;
        color: #9fb6d8;
        line-height: 1.5;
      }
      code {
        color: #cfe1ff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Terminal unavailable</h1>
      <p><code>${request.path}</code> is served by the Manor Docker gateway. Start the full Docker stack to use the embedded terminal.</p>
    </main>
  </body>
</html>`);
});

if (viteDevServer) {
  app.use(viteDevServer.middlewares);
  app.get(/.*/, async (request, response, next) => {
    try {
      const template = await fs.readFile(indexTemplatePath, "utf8");
      const html = await viteDevServer!.transformIndexHtml(request.originalUrl, template);
      response.status(200).type("html").send(html);
    } catch (error) {
      viteDevServer!.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
} else {
  app.use(express.static(staticDir));
  app.get(/.*/, async (_request, response) => {
    response.sendFile(path.join(staticDir, "index.html"));
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Butler listening on ${port} (${hotReloadEnabled ? "hot reload" : "static"})`);
});

server.on("upgrade", (request, socket, head) => {
  const previewRoute =
    resolvePreviewRouteUrl(request.url) ??
    resolvePreviewRefererRouteUrl(request.url, request.headers.referer ?? request.headers.referrer);
  if (!previewRoute) {
    socket.destroy();
    return;
  }

  const target = resolvePreviewProxyTarget(runtimeAccess, previewRoute.leaseId);
  if (!target) {
    socket.destroy();
    return;
  }

  request.url = previewRoute.brokerUrl;
  previewProxy.ws(request, socket, head, { target }, () => {
    socket.destroy();
  });
});

server.on("close", () => { automationScheduler.stop(); stopOllamaCloudModelRecovery(); modelInventoryRefresh.dispose();
  clearInterval(leaseReaper);
  clearInterval(runtimeCleanupWorker);
  clearInterval(artifactReaper);
  clearInterval(runtimeReconciler);
  memoryEmbeddings.dispose();
  memorySemanticEdges.stop();
});
