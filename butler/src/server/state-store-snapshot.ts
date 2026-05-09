import { buildLatestProofMap, buildProofsByThreadMap } from "./butler-agent-helpers.js";
import { normalizeWindow } from "./state-store-helpers.js";
import type {
  AppShellSnapshot,
  AppSnapshot,
  ButlerWindow,
  CodexThreadRecord,
  PreviewProofRecordView,
  RuntimeSnapshot
} from "./types.js";

type SnapshotAccess = {
  threads: Map<string, CodexThreadRecord>;
  windows: ButlerWindow[];
  focusedWindowId: string | null;
  reconcileThreadWindows(): boolean;
  queueSave(): void;
  listThreads(): AppSnapshot["codex"]["threads"];
  listPreviewProofs(): PreviewProofRecordView[];
  listStackLeases(): AppSnapshot["butler"]["stacks"];
  listPreviewLeases(): AppSnapshot["butler"]["previews"];
  listServiceLeases(): AppSnapshot["butler"]["services"];
  listDesktopSessions(): AppSnapshot["butler"]["desktopSessions"];
  listProjectSummaries(): AppSnapshot["butler"]["supervision"]["projects"];
  getSupervisorSummary(): AppSnapshot["butler"]["supervision"]["supervisor"];
};

export function buildStateStoreRuntimeSnapshot(
  access: SnapshotAccess,
  serviceTemplates: AppSnapshot["butler"]["serviceTemplates"]
): RuntimeSnapshot {
  const previewProofs = access.listPreviewProofs();
  return {
    latestPreviewProofsByThreadId: buildLatestProofMap(previewProofs),
    previewProofsByThreadId: buildProofsByThreadMap(previewProofs),
    stacks: access.listStackLeases(),
    previews: access.listPreviewLeases(),
    serviceTemplates,
    services: access.listServiceLeases(),
    desktopSessions: access.listDesktopSessions()
  };
}

export function buildStateStoreShellSnapshot(
  access: SnapshotAccess,
  butler: AppShellSnapshot["butler"],
  codexConnection: {
    connected: boolean;
    lastError: string | null;
    auth: AppSnapshot["codex"]["auth"];
    compose: AppSnapshot["codex"]["compose"];
  }
): AppShellSnapshot {
  if (access.reconcileThreadWindows()) {
    access.queueSave();
  }
  access.windows = access.windows.map((window) => normalizeWindow(window, access.threads.get(window.threadId)));

  return {
    codex: {
      connected: codexConnection.connected,
      lastError: codexConnection.lastError,
      auth: codexConnection.auth,
      threads: access.listThreads(),
      windows: access.windows,
      focusedWindowId: access.focusedWindowId,
      compose: codexConnection.compose
    },
    butler
  };
}

export function buildStateStoreSnapshot(
  access: SnapshotAccess,
  butler: {
    ready: boolean;
    pending: boolean;
    isStreaming: boolean;
    sessionId: string | null;
    model: string | null;
    auth: AppSnapshot["butler"]["auth"];
    messages: AppSnapshot["butler"]["messages"];
    messageCount: number;
    tools: AppSnapshot["butler"]["tools"];
    onboarding: AppSnapshot["butler"]["onboarding"];
    contextUsage: AppSnapshot["butler"]["contextUsage"];
    compaction: AppSnapshot["butler"]["compaction"];
    supervision: AppSnapshot["butler"]["supervision"];
    stacks: AppSnapshot["butler"]["stacks"];
    previews: AppSnapshot["butler"]["previews"];
    serviceTemplates: AppSnapshot["butler"]["serviceTemplates"];
    services: AppSnapshot["butler"]["services"];
    lastError: string | null;
    compose: AppSnapshot["butler"]["compose"];
  },
  codexConnection: {
    connected: boolean;
    lastError: string | null;
    auth: AppSnapshot["codex"]["auth"];
    compose: AppSnapshot["codex"]["compose"];
  }
): AppSnapshot {
  if (access.reconcileThreadWindows()) {
    access.queueSave();
  }
  access.windows = access.windows.map((window) => normalizeWindow(window, access.threads.get(window.threadId)));
  const openThreads = Object.fromEntries(
    access.windows
      .map((window) => {
        const thread = access.threads.get(window.threadId);
        return thread ? [window.threadId, thread] : null;
      })
      .filter((entry): entry is [string, CodexThreadRecord] => Boolean(entry))
  );

  return {
    codex: {
      connected: codexConnection.connected,
      lastError: codexConnection.lastError,
      auth: codexConnection.auth,
      threads: access.listThreads(),
      windows: access.windows,
      focusedWindowId: access.focusedWindowId,
      openThreads,
      compose: codexConnection.compose
    },
    butler: {
      ...butler,
      supervision: {
        ...butler.supervision,
        projects: access.listProjectSummaries(),
        supervisor: access.getSupervisorSummary()
      },
      latestPreviewProofsByThreadId: buildLatestProofMap(access.listPreviewProofs()),
      previewProofsByThreadId: buildProofsByThreadMap(access.listPreviewProofs()),
      stacks: access.listStackLeases(),
      previews: access.listPreviewLeases(),
      serviceTemplates: butler.serviceTemplates,
      services: access.listServiceLeases(),
      desktopSessions: access.listDesktopSessions()
    }
  };
}
