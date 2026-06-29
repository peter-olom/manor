import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CodexInputItem } from "./image-store.js";
import { cleanupManagedWorktree, resolveExistingWorkspaceCwd } from "./repo-worktree.js";
import { listFilesRecursive, listThreadSessionFiles, listThreadSnapshotFiles, normalizeTimestampMs } from "./codex-session-artifacts.js";
import { recoverCodexTranscriptActivity } from "./codex-transcript-activity.js";
import { ButlerStateStore } from "./state-store.js";
import { CodexAppServerTransport, type JsonRpcMessage } from "./codex-app-server-transport.js";
import { CodexProviderAdapter } from "./codex-provider-adapter.js";
import { ProviderRuntimeIngestion } from "./provider-runtime-ingestion.js";
import type { MemoryUpdateScheduler } from "./memory-update-scheduler.js";
import type { CodexThreadPatchView, ModelOption, ReasoningEffort, RuntimeCleanupTaskView } from "./types.js";
import type { ProviderRuntimeEvent, ProviderRuntimeLivePatch } from "../shared/provider-runtime.js";

type ThreadDeleteContext = {
  threadId: string;
  cwd: string | null;
  threadCreatedAt: number | null;
  stacks: RuntimeCleanupTaskView["stacks"];
  previews: RuntimeCleanupTaskView["previews"];
  services: RuntimeCleanupTaskView["services"];
  proofArtifactPaths?: string[];
};

export type ComposerSuggestionInputItem =
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name?: string;
      path: string;
    };

export type ComposerSuggestion = {
  id: string;
  kind: "file" | "directory" | "skill" | "app" | "plugin" | "agent";
  label: string;
  detail: string | null;
  insertText: string;
  inputItem?: ComposerSuggestionInputItem;
};

type FsDirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

const COMPOSER_FILE_EXCLUDED_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);
const COMPOSER_SUGGESTION_LIMIT = 32;

function normalizeSuggestionQuery(query: string): string {
  return query.trim().toLowerCase();
}

function relativeDisplayPath(root: string, entryPath: string): string {
  const relative = path.relative(root, entryPath);
  return relative && !relative.startsWith("..") ? relative : entryPath;
}

function matchesSuggestion(query: string, ...values: Array<string | null | undefined>): boolean {
  if (!query) {
    return true;
  }

  return values.some((value) => value?.toLowerCase().includes(query));
}

function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeModelLabel(rawLabel: string, id: string): string {
  const source = rawLabel.trim() || id.trim();
  if (!source) {
    return id;
  }

  const normalized = source.replace(/\s+/g, "-");
  const parts = normalized.split("-").filter(Boolean);
  if (parts.length < 2) {
    return source;
  }

  const head = parts[0]?.toLowerCase() === "gpt" ? "GPT" : parts[0];
  const version = parts[1] ?? "";
  const suffix = parts
    .slice(2)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "codex") {
        return "Codex";
      }
      if (lower === "mini") {
        return "Mini";
      }
      if (lower === "max") {
        return "Max";
      }
      if (lower === "spark") {
        return "Spark";
      }
      return part.length > 1 ? `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}` : part.toUpperCase();
    })
    .join(" ");

  return `${head}-${version}${suffix ? ` ${suffix}` : ""}`;
}

function parseModelSortKey(model: Pick<ModelOption, "id" | "label">): { version: number[]; suffixWeight: number; label: string } {
  const source = `${model.id} ${model.label}`.toLowerCase().replace(/\s+/g, "-");
  const match = source.match(/(?:^|-)gpt-(\d+(?:\.\d+)*)([^ ]*)/);
  const version = match ? match[1]!.split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite) : [];
  const suffixWeight = match?.[2] ? match[2]!.split("-").filter(Boolean).length : 0;

  return {
    version,
    suffixWeight,
    label: model.label.toLowerCase()
  };
}

function compareModelsByNewest(a: ModelOption, b: ModelOption): number {
  const aKey = parseModelSortKey(a);
  const bKey = parseModelSortKey(b);
  const length = Math.max(aKey.version.length, bKey.version.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (bKey.version[index] ?? -1) - (aKey.version[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }

  if (aKey.suffixWeight !== bKey.suffixWeight) {
    return aKey.suffixWeight - bKey.suffixWeight;
  }

  return aKey.label.localeCompare(bKey.label);
}

function normalizeInputItems(input: string | CodexInputItem[]): CodexInputItem[] {
  if (typeof input === "string") {
    const message = input.trim();
    if (!message) {
      throw new Error("text is required");
    }

    return [{ type: "text", text: message }];
  }

  const normalized = input.filter((item) => {
    if (item.type === "text") {
      return item.text.trim().length > 0;
    }

    return item.path.trim().length > 0;
  });

  if (normalized.length === 0) {
    throw new Error("input is required");
  }

  return normalized;
}

export class CodexAppServerClient extends EventEmitter {
  private readonly store: ButlerStateStore;
  private readonly transport: CodexAppServerTransport;
  private readonly codexProviderAdapter: CodexProviderAdapter;
  private readonly resumedThreadIds = new Set<string>();
  private readonly directControlThreadIds = new Set<string>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly deletedThreadIds = new Set<string>();
  private lastError: string | null = null;
  private availableModels: ModelOption[] = [];
  private selectedModel: string | null = null;
  private selectedEffort: ReasoningEffort | null = null;
  private readonly defaultCwd = "/repos";
  private readonly codexHomeDir: string;
  private readonly artifactsDir: string | null;
  private readonly onThreadCapabilityReady: ((threadId: string, cwd: string | null | undefined) => Promise<void>) | null;
  private readonly onThreadCapabilityRemoved: ((threadId: string) => Promise<void>) | null;
  private readonly onThreadDeleting: ((context: ThreadDeleteContext) => Promise<void>) | null;
  private readonly memoryScheduler: MemoryUpdateScheduler | null;
  private readonly onRuntimeCleanupError: ((threadId: string, message: string) => void) | null;
  private readonly providerRuntimeIngestion: ProviderRuntimeIngestion;
  private cleanupQueueRunning = false;

  constructor(
    baseUrl: string,
    store: ButlerStateStore,
    codexHomeDir: string,
    options?: {
      onThreadCapabilityReady?: (threadId: string, cwd: string | null | undefined) => Promise<void>;
      onThreadCapabilityRemoved?: (threadId: string) => Promise<void>;
      onThreadDeleting?: (context: ThreadDeleteContext) => Promise<void>;
      memoryScheduler?: MemoryUpdateScheduler | null;
      onRuntimeCleanupError?: (threadId: string, message: string) => void;
      artifactsDir?: string | null;
      authTokenFile?: string | null;
      providerRuntimeIngestion?: ProviderRuntimeIngestion | null;
    }
  ) {
    super();
    this.store = store;
    this.codexHomeDir = codexHomeDir;
    this.artifactsDir = options?.artifactsDir ? path.resolve(options.artifactsDir) : null;
    this.onThreadCapabilityReady = options?.onThreadCapabilityReady ?? null;
    this.onThreadCapabilityRemoved = options?.onThreadCapabilityRemoved ?? null;
    this.onThreadDeleting = options?.onThreadDeleting ?? null;
    this.memoryScheduler = options?.memoryScheduler ?? null;
    this.onRuntimeCleanupError = options?.onRuntimeCleanupError ?? null;
    this.providerRuntimeIngestion = options?.providerRuntimeIngestion ?? new ProviderRuntimeIngestion(store);
    this.providerRuntimeIngestion.on("runtimePatch", (patch) => this.handleRuntimePatch(patch));
    this.transport = new CodexAppServerTransport(baseUrl, {
      authTokenFile: options?.authTokenFile ? path.resolve(options.authTokenFile) : null,
      onReady: async () => {
        this.lastError = null;
        this.emit("change");
        await this.loadModels();
        await this.seedThreads();
        this.store.enableMilestones();
      },
      onClosed: () => {
        this.resumedThreadIds.clear();
        this.directControlThreadIds.clear();
        this.activeTurnIds.clear();
      }
    });
    this.codexProviderAdapter = new CodexProviderAdapter(this.transport);
    this.transport.on("notification", (message) => this.handleMessage(message as JsonRpcMessage));
    this.transport.on("change", () => {
      this.emit("change");
    });
    this.codexProviderAdapter.on("runtimeEvent", (event) => {
      if (!this.deletedThreadIds.has(event.threadId)) {
        this.ingestRuntimeEvent(event);
      }
    });
    this.codexProviderAdapter.on("unmappedNotification", (message) => this.handleUnmappedNotification(message));
  }

  start(): void {
    this.transport.start();
  }

  private async requireExistingWorkspace(cwd: string | null | undefined): Promise<string | null> {
    const normalized = typeof cwd === "string" ? cwd.trim() : "";
    if (!normalized) {
      return null;
    }

    const resolved = await resolveExistingWorkspaceCwd(normalized);
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      throw new Error(`Requested workspace does not exist: ${normalized}`);
    }
  }

  private handleRuntimePatch(patch: ProviderRuntimeLivePatch): void {
    this.emit("threadPatch", patch satisfies CodexThreadPatchView);
  }

  private noteRuntimeEvent(event: ProviderRuntimeEvent): void {
    if (event.type === "turn.started" && event.turnId) {
      this.activeTurnIds.set(event.threadId, event.turnId);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted" || event.type === "session.exited") {
      this.activeTurnIds.delete(event.threadId);
    }
  }

  private ingestRuntimeEvent(event: ProviderRuntimeEvent): void {
    this.noteRuntimeEvent(event);
    void this.providerRuntimeIngestion.ingest(event).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("change");
    });
  }

  getConnectionState(): { connected: boolean; lastError: string | null; compose: { model: string | null; effort: ReasoningEffort | null; availableModels: ModelOption[] } } {
    const transportState = this.transport.getState();
    return {
      connected: transportState.connected,
      lastError: this.lastError ?? transportState.lastError,
      compose: {
        model: this.selectedModel,
        effort: this.selectedEffort,
        availableModels: this.availableModels
      }
    };
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (!message.method) {
      return;
    }

    this.codexProviderAdapter.handleNotification(message);
  }

  private handleUnmappedNotification(message: JsonRpcMessage): void {
    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;

    if (threadId && this.deletedThreadIds.has(threadId)) {
      return;
    }

    if (threadId) {
      this.store.addEvent(threadId, message.method, JSON.stringify(params).slice(0, 240));
      this.emit("change");
    }
  }

  private async seedThreads(): Promise<void> {
    let cursor: string | null = null;

    do {
      const result = await this.codexProviderAdapter.listThreads({
        cursor,
        limit: 100,
        sourceKinds: ["appServer", "cli", "vscode"]
      });

      for (const thread of result.data) {
        if (typeof thread.id === "string" && this.deletedThreadIds.has(thread.id)) {
          continue;
        }
        this.store.upsertThreadSummary(thread);
      }

      cursor = result.nextCursor;
    } while (cursor);

    const loadedIds = await this.codexProviderAdapter.listLoadedThreads();
    this.store.markLoadedThreads(loadedIds);
    this.store.markThreadInventoryReady();

    for (const threadId of loadedIds) {
      await this.resumeThread(threadId).catch(() => undefined);
    }

    for (const threadId of this.store.getOpenWindowIds()) {
      await this.loadThread(threadId).catch(() => undefined);
    }
  }

  private async loadModels(): Promise<void> {
    let cursor: string | null = null;
    const models: ModelOption[] = [];

    do {
      const result = await this.codexProviderAdapter.listModels({
        cursor,
        limit: 100,
        includeHidden: false
      });

      for (const entry of result.data) {
        const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : null;
        if (!id) {
          continue;
        }

        const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts
              .map((option) =>
                option && typeof option === "object" && "reasoningEffort" in option && typeof option.reasoningEffort === "string"
                  ? (option.reasoningEffort as ReasoningEffort)
                  : null
              )
              .filter((value): value is ReasoningEffort => Boolean(value))
          : [];

        models.push({
          id,
          label: normalizeModelLabel(typeof entry.displayName === "string" ? entry.displayName : id, id),
          provider: null,
          supportsReasoning: supportedReasoningEfforts.length > 0,
          supportedReasoningEfforts,
          defaultReasoningEffort:
            typeof entry.defaultReasoningEffort === "string" ? (entry.defaultReasoningEffort as ReasoningEffort) : supportedReasoningEfforts[0] ?? null
        });
      }

      cursor = result.nextCursor;
    } while (cursor);

    this.availableModels = [...models].sort(compareModelsByNewest);
    const defaultModel = this.availableModels.find((model) => model.id === this.selectedModel) ?? this.availableModels[0] ?? null;
    this.selectedModel = defaultModel?.id ?? null;
    this.selectedEffort = defaultModel ? this.resolveEffort(defaultModel, this.selectedEffort) : null;
    this.emit("change");
  }

  private async listComposerFiles(root: string, query: string): Promise<ComposerSuggestion[]> {
    const normalizedRoot = await this.requireExistingWorkspace(root);
    if (!normalizedRoot) {
      return [];
    }

    const suggestions: ComposerSuggestion[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: normalizedRoot, depth: 0 }];
    const maxDepth = query.length >= 2 ? 5 : 2;

    while (queue.length > 0 && suggestions.length < COMPOSER_SUGGESTION_LIMIT) {
      const current = queue.shift()!;
      const result = await this.codexProviderAdapter.readDirectory(current.dir);
      const entries = Array.isArray(result?.entries) ? (result.entries as FsDirectoryEntry[]) : [];

      for (const entry of entries) {
        if (!entry || typeof entry.fileName !== "string" || COMPOSER_FILE_EXCLUDED_NAMES.has(entry.fileName)) {
          continue;
        }

        const entryPath = path.join(current.dir, entry.fileName);
        const relativePath = relativeDisplayPath(normalizedRoot, entryPath);
        const isDirectory = Boolean(entry.isDirectory);
        const isFile = Boolean(entry.isFile);

        if ((isFile || isDirectory) && matchesSuggestion(query, entry.fileName, relativePath)) {
          suggestions.push({
            id: `file:${entryPath}`,
            kind: isDirectory ? "directory" : "file",
            label: entry.fileName,
            detail: relativePath,
            insertText: `@${relativePath}`
          });
        }

        if (isDirectory && current.depth < maxDepth && suggestions.length < COMPOSER_SUGGESTION_LIMIT) {
          queue.push({ dir: entryPath, depth: current.depth + 1 });
        }

        if (suggestions.length >= COMPOSER_SUGGESTION_LIMIT) {
          break;
        }
      }
    }

    return suggestions;
  }

  private async listComposerSkills(cwd: string, query: string): Promise<ComposerSuggestion[]> {
    const groups = await this.codexProviderAdapter.listSkills({
      cwds: [cwd],
      forceReload: false
    });

    const skills = groups.flatMap((group) => (Array.isArray(group.skills) ? (group.skills as Record<string, unknown>[]) : []));

    return skills
      .filter((skill) => typeof skill.name === "string" && typeof skill.path === "string")
      .filter((skill) =>
        matchesSuggestion(
          query,
          skill.name as string,
          typeof skill.description === "string" ? skill.description : null,
          typeof (skill.interface as Record<string, unknown> | undefined)?.displayName === "string"
            ? ((skill.interface as Record<string, unknown>).displayName as string)
            : null
        )
      )
      .slice(0, COMPOSER_SUGGESTION_LIMIT)
      .map((skill) => {
        const interfaceInfo = skill.interface && typeof skill.interface === "object" ? (skill.interface as Record<string, unknown>) : null;
        const name = skill.name as string;
        const displayName = typeof interfaceInfo?.displayName === "string" ? interfaceInfo.displayName : name;
        return {
          id: `skill:${skill.path as string}`,
          kind: "skill",
          label: displayName,
          detail: name,
          insertText: `$${name}`,
          inputItem: {
            type: "skill",
            name,
            path: skill.path as string
          }
        };
      });
  }

  private async listComposerApps(query: string, threadId?: string | null): Promise<ComposerSuggestion[]> {
    const apps = await this.codexProviderAdapter.listApps({
      limit: 100,
      ...(threadId ? { threadId } : {})
    });

    return apps
      .filter((app) => typeof app.id === "string" && typeof app.name === "string")
      .filter((app) => app.isAccessible !== false && app.isEnabled !== false)
      .filter((app) => matchesSuggestion(query, app.name as string, typeof app.description === "string" ? app.description : null))
      .slice(0, COMPOSER_SUGGESTION_LIMIT)
      .map((app) => {
        const name = app.name as string;
        const slug = slugFromName(name);
        return {
          id: `app:${app.id as string}`,
          kind: "app",
          label: name,
          detail: typeof app.description === "string" ? app.description : null,
          insertText: `$${slug}`,
          inputItem: {
            type: "mention",
            name,
            path: `app://${app.id as string}`
          }
        };
      });
  }

  private async listComposerPlugins(query: string): Promise<ComposerSuggestion[]> {
    const marketplaces = await this.codexProviderAdapter.listPluginMarketplaces({ limit: 100 });
    const plugins = marketplaces.flatMap((marketplace) =>
      Array.isArray(marketplace.plugins) ? (marketplace.plugins as Record<string, unknown>[]) : []
    );

    return plugins
      .filter((plugin) => typeof plugin.name === "string")
      .filter((plugin) => {
        const interfaceInfo = plugin.interface && typeof plugin.interface === "object" ? (plugin.interface as Record<string, unknown>) : null;
        return matchesSuggestion(
          query,
          plugin.name as string,
          typeof interfaceInfo?.displayName === "string" ? interfaceInfo.displayName : null,
          typeof interfaceInfo?.shortDescription === "string" ? interfaceInfo.shortDescription : null
        );
      })
      .slice(0, COMPOSER_SUGGESTION_LIMIT)
      .map((plugin) => {
        const interfaceInfo = plugin.interface && typeof plugin.interface === "object" ? (plugin.interface as Record<string, unknown>) : null;
        const name = plugin.name as string;
        return {
          id: `plugin:${typeof plugin.id === "string" ? plugin.id : name}`,
          kind: "plugin",
          label: typeof interfaceInfo?.displayName === "string" ? interfaceInfo.displayName : name,
          detail: typeof interfaceInfo?.shortDescription === "string" ? interfaceInfo.shortDescription : name,
          insertText: `@${name}`
        };
      });
  }

  private async listComposerAgents(query: string): Promise<ComposerSuggestion[]> {
    const modes = await this.codexProviderAdapter.listCollaborationModes();

    return modes
      .filter((mode) => typeof mode.name === "string" && typeof mode.mode === "string")
      .filter((mode) => matchesSuggestion(query, mode.name as string, mode.mode as string))
      .slice(0, COMPOSER_SUGGESTION_LIMIT)
      .map((mode) => ({
        id: `agent:${mode.mode as string}`,
        kind: "agent",
        label: mode.name as string,
        detail: mode.mode as string,
        insertText: `@${mode.name as string}`
      }));
  }

  async listComposerSuggestions(options: {
    trigger: "@" | "$";
    query: string;
    cwd?: string | null;
    threadId?: string | null;
  }): Promise<ComposerSuggestion[]> {
    const query = normalizeSuggestionQuery(options.query);
    const cwd = (await this.requireExistingWorkspace(options.cwd).catch(() => null)) ?? this.defaultCwd;

    if (options.trigger === "$") {
      const [skills, apps] = await Promise.all([
        this.listComposerSkills(cwd, query).catch(() => []),
        this.listComposerApps(query, options.threadId).catch(() => [])
      ]);
      return [...skills, ...apps].slice(0, COMPOSER_SUGGESTION_LIMIT);
    }

    const [files, plugins, agents] = await Promise.all([
      this.listComposerFiles(cwd, query).catch(() => []),
      this.listComposerPlugins(query).catch(() => []),
      this.listComposerAgents(query).catch(() => [])
    ]);

    return [...files, ...plugins, ...agents].slice(0, COMPOSER_SUGGESTION_LIMIT);
  }

  private resolveEffort(model: ModelOption, effort: ReasoningEffort | null): ReasoningEffort | null {
    if (!model.supportsReasoning) {
      return null;
    }

    if (effort && model.supportedReasoningEfforts.includes(effort)) {
      return effort;
    }

    return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
  }

  private buildTurnExecutionConfig(): Record<string, unknown> {
    return {
      cwd: this.defaultCwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess"
      }
    };
  }

  private buildResumeConfig(): Record<string, unknown> {
    return {
      cwd: this.defaultCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access"
    };
  }

  private buildThreadStartConfig(overrides?: {
    cwd?: string | null;
    developerInstructions?: string | null;
    serviceName?: string | null;
  }): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: overrides?.cwd ?? this.defaultCwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceName: overrides?.serviceName ?? "Butler"
    };

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (overrides?.developerInstructions) {
      params.developerInstructions = overrides.developerInstructions;
    }

    return params;
  }

  private async ensureInteractiveThread(threadId: string): Promise<string> {
    if (this.directControlThreadIds.has(threadId)) {
      return threadId;
    }

    const thread = this.store.getThread(threadId);
    await this.resumeThread(threadId, true);
    this.directControlThreadIds.add(threadId);

    if (thread && thread.source !== "appServer") {
      this.store.addEvent(threadId, "thread/direct-control", "Butler attached direct control without creating a new thread");
    }

    return threadId;
  }

  async loadThread(threadId: string): Promise<void> {
    this.deletedThreadIds.delete(threadId);
    const result = await this.codexProviderAdapter.loadThread(threadId);

    if (result.thread && typeof result.thread === "object") {
      this.store.setThreadDetail(result.thread as Record<string, unknown>);
      const detail = result.thread as Record<string, unknown>;
      await this.onThreadCapabilityReady?.(
        threadId,
        typeof detail.cwd === "string" ? detail.cwd : this.store.getThread(threadId)?.cwd
      );
    }

    await this.restoreThreadUsage(threadId).catch(() => undefined);
    await this.restoreThreadTranscriptActivity(threadId).catch(() => undefined);
    await this.resumeThread(threadId).catch(() => undefined);
  }

  private async restoreThreadTranscriptActivity(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    const turns = await recoverCodexTranscriptActivity(this.codexHomeDir, threadId, thread?.createdAt ?? null);
    for (const turn of turns) {
      for (const item of turn.items) {
        const current = this.store.getThread(threadId)?.turns
          .find((entry) => entry.id === turn.turnId)
          ?.items.find((entry) => entry.id === item.id);
        if (current && current.type === item.type && current.text === item.text && current.status === item.status && current.at === item.at) {
          continue;
        }
        this.store.updateItem(threadId, turn.turnId, { ...item }, item.status);
      }
    }
  }

  async resumeThread(threadId: string, forceConfig = false): Promise<void> {
    this.deletedThreadIds.delete(threadId);
    if (!forceConfig && this.resumedThreadIds.has(threadId)) {
      return;
    }

    const result = await this.codexProviderAdapter.resumeThread(threadId, this.buildResumeConfig());
    if (result.thread && typeof result.thread === "object") {
      this.store.upsertThreadSummary(result.thread as Record<string, unknown>);
    }
    this.resumedThreadIds.add(threadId);
  }

  async updateComposeSettings(modelId: string, effort: ReasoningEffort | null): Promise<void> {
    const model = this.availableModels.find((entry) => entry.id === modelId);
    if (!model) {
      throw new Error("Selected Codex model is not available");
    }

    this.selectedModel = model.id;
    this.selectedEffort = this.resolveEffort(model, effort);
    this.emit("change");
  }

  async updateThreadReasoningEffort(threadId: string, effort: ReasoningEffort): Promise<void> {
    if (!effort) {
      throw new Error("effort is required");
    }
    await this.updateThreadSettings(threadId, { effort });
  }

  async updateThreadSettings(threadId: string, settings: { model?: string | null; effort?: ReasoningEffort | null }): Promise<void> {
    if (!threadId) {
      throw new Error("threadId is required");
    }
    const params: Record<string, unknown> = { threadId };
    let model: ModelOption | null = null;
    if (settings.model) {
      model = this.availableModels.find((entry) => entry.id === settings.model) ?? null;
      if (!model) {
        throw new Error("Selected Codex model is not available");
      }
      params.model = model.id;
    }
    if (settings.effort) {
      const resolvedEffort = model ? this.resolveEffort(model, settings.effort) : settings.effort;
      if (!resolvedEffort) {
        throw new Error("Selected Codex effort is not available for this model");
      }
      params.effort = resolvedEffort;
    }
    if (!params.model && !params.effort) {
      throw new Error("model or effort is required");
    }
    await this.codexProviderAdapter.call("thread/settings/update", params);
  }

  private syncComposeEffort(effort: ReasoningEffort | null): void {
    if (!effort) {
      return;
    }

    const model = this.availableModels.find((entry) => entry.id === this.selectedModel);
    if (!model || model.supportedReasoningEfforts.includes(effort)) {
      this.selectedEffort = effort;
    }
  }

  async startThread(options: {
    task: string;
    input?: CodexInputItem[] | ((threadId: string) => CodexInputItem[] | Promise<CodexInputItem[]>);
    cwd?: string | null;
    developerInstructions?: string | null;
    effort?: ReasoningEffort | null;
    openWindow?: boolean;
  }): Promise<{ threadId: string; turnId: string | null }> {
    const task = options.task.trim();
    if (!task) {
      throw new Error("task is required");
    }

    const threadCwd = await this.requireExistingWorkspace(options.cwd);

    const started = await this.codexProviderAdapter.startThread(this.buildThreadStartConfig({
      cwd: threadCwd ?? this.defaultCwd,
      developerInstructions: options.developerInstructions ?? null
    }));

    const thread = started.thread && typeof started.thread === "object" ? (started.thread as Record<string, unknown>) : null;
    const threadId = started.threadId;

    this.deletedThreadIds.delete(threadId);
    if (thread) {
      this.store.upsertThreadSummary(thread);
    }
    await this.onThreadCapabilityReady?.(threadId, threadCwd ?? (thread && typeof thread.cwd === "string" ? thread.cwd : null));
    this.resumedThreadIds.add(threadId);
    this.directControlThreadIds.add(threadId);

    const resolvedInput =
      typeof options.input === "function" ? await options.input(threadId) : (options.input ?? task);
    const params: Record<string, unknown> = {
      threadId,
      input: normalizeInputItems(resolvedInput)
    };

    if (threadCwd) {
      params.cwd = threadCwd;
    }

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    this.syncComposeEffort(options.effort ?? null);
    const requestedEffort = options.effort ?? this.selectedEffort;
    if (requestedEffort) {
      params.effort = requestedEffort;
      this.store.setThreadRequestedReasoningEffort(threadId, requestedEffort);
    }

    const turnResult = await this.codexProviderAdapter.sendTurn(threadId, params);
    let turnId: string | null = turnResult.turnId ?? null;
    if (turnResult.turn && typeof turnResult.turn === "object") {
      const turn = turnResult.turn as Record<string, unknown>;
      if (typeof turn.id === "string") {
        turnId = turn.id;
        this.activeTurnIds.set(threadId, turn.id);
        if (requestedEffort) {
          this.store.setThreadRequestedReasoningEffort(threadId, requestedEffort, turn.id);
        }
      }
      this.store.updateTurn(threadId, turn);
    }

    if (options.openWindow !== false) {
      this.store.openWindow(threadId);
    }

    this.emit("change");
    return { threadId, turnId };
  }

  async sendMessage(threadId: string, input: string | CodexInputItem[]): Promise<{ threadId: string; turnId: string | null }> {
    const inputItems = normalizeInputItems(input);
    const threadWorkspace = await this.requireExistingWorkspace(this.store.getThread(threadId)?.cwd);
    if (threadWorkspace) {
      this.store.upsertThreadSummary({ id: threadId, cwd: threadWorkspace });
    }
    await this.onThreadCapabilityReady?.(threadId, threadWorkspace);
    const targetThreadId = await this.ensureInteractiveThread(threadId);

    const activeTurnId = this.activeTurnIds.get(targetThreadId);
    if (activeTurnId) {
      if (threadWorkspace) {
        this.store.upsertThreadSummary({ id: targetThreadId, cwd: threadWorkspace });
      }
      await this.codexProviderAdapter.steerTurn(targetThreadId, activeTurnId, inputItems);
      return { threadId: targetThreadId, turnId: activeTurnId };
    }

    const params: Record<string, unknown> = {
      threadId: targetThreadId,
      input: inputItems,
      ...this.buildTurnExecutionConfig()
    };

    if (threadWorkspace) {
      params.cwd = threadWorkspace;
    }

    if (this.selectedModel) {
      params.model = this.selectedModel;
    }

    if (this.selectedEffort) {
      params.effort = this.selectedEffort;
    }

    const result = await this.codexProviderAdapter.sendTurn(targetThreadId, params);
    if (threadWorkspace) {
      this.store.upsertThreadSummary({ id: targetThreadId, cwd: threadWorkspace });
    }
    if (result.turn && typeof result.turn === "object") {
      this.store.updateTurn(targetThreadId, result.turn as Record<string, unknown>);
    }
    return { threadId: targetThreadId, turnId: result.turnId ?? null };
  }

  async stopThread(threadId: string): Promise<boolean> {
    const activeTurnId = this.activeTurnIds.get(threadId);
    if (!activeTurnId) {
      return false;
    }

    await this.codexProviderAdapter.interruptTurn(threadId, activeTurnId);
    this.activeTurnIds.delete(threadId);
    this.store.setThreadStatus(threadId, "idle");
    this.store.addEvent(threadId, "turn/interrupt", "Turn interrupted by operator");
    this.emit("change");
    return true;
  }

  private async restoreThreadUsage(threadId: string): Promise<void> {
    const sessionFiles = await listThreadSessionFiles(this.codexHomeDir, threadId, this.store.getThread(threadId)?.createdAt ?? null);

    if (sessionFiles.length === 0) {
      return;
    }

    const datedFiles = await Promise.all(
      sessionFiles.map(async (filePath) => ({
        filePath,
        modifiedAt: (await fs.stat(filePath).catch(() => null))?.mtimeMs ?? 0
      }))
    );

    datedFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);

    for (const candidate of datedFiles) {
      const usage = await this.readUsageFromSession(candidate.filePath);
      if (!usage) {
        continue;
      }

      this.store.updateThreadTokenUsage(threadId, usage);
      return;
    }
  }

  private async readUsageFromSession(
    filePath: string
  ): Promise<{ totalTokens: number | null; modelContextWindow: number | null } | null> {
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (!content) {
      return null;
    }

    const lines = content.trim().split("\n").reverse();

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type !== "event_msg") {
        continue;
      }

      const payload = parsed.payload && typeof parsed.payload === "object" ? (parsed.payload as Record<string, unknown>) : null;
      if (!payload || payload.type !== "token_count") {
        continue;
      }

      const info = payload.info && typeof payload.info === "object" ? (payload.info as Record<string, unknown>) : null;
      if (!info) {
        continue;
      }

      const lastUsage =
        info.last_token_usage && typeof info.last_token_usage === "object"
          ? (info.last_token_usage as Record<string, unknown>)
          : null;
      const totalUsage =
        info.total_token_usage && typeof info.total_token_usage === "object"
          ? (info.total_token_usage as Record<string, unknown>)
          : null;

      return {
        totalTokens:
          typeof lastUsage?.total_tokens === "number"
            ? lastUsage.total_tokens
            : typeof totalUsage?.total_tokens === "number"
              ? totalUsage.total_tokens
              : null,
        modelContextWindow: typeof info.model_context_window === "number" ? info.model_context_window : null
      };
    }

    return null;
  }

  private listThreadProofArtifactPaths(threadId: string): string[] {
    const paths = this.store.listPreviewProofs().filter((proof) => proof.threadId === threadId).flatMap((proof) =>
      proof.verification.artifacts.map((artifact) => artifact.filePath).filter((filePath): filePath is string => Boolean(filePath))
    );
    return [...new Set(paths)];
  }

  private async deleteThreadArtifacts(threadId: string, cwd: string | null, threadCreatedAt: number | null, queuedProofArtifactPaths: string[] = []): Promise<number> {
    const removed = new Set<string>();
    const generatedImagesDir = path.join(this.codexHomeDir, "generated_images", threadId);

    // Codex session history is date-sharded. Scanning the whole tree for every
    // deletion becomes expensive on long-lived hosts, so use thread metadata to
    // touch only the likely daily folders.
    const sessionFiles = await listThreadSessionFiles(this.codexHomeDir, threadId, threadCreatedAt);
    for (const filePath of sessionFiles) {
      await fs.rm(filePath, { force: true });
      removed.add(filePath);
    }

    const snapshotFiles = await listThreadSnapshotFiles(this.codexHomeDir, threadId);
    for (const filePath of snapshotFiles) {
      await fs.rm(filePath, { force: true });
      removed.add(filePath);
    }

    const generatedImages = await listFilesRecursive(generatedImagesDir);
    await fs.rm(generatedImagesDir, { recursive: true, force: true });
    for (const filePath of generatedImages) {
      removed.add(filePath);
    }

    const previewProofs = this.store.listPreviewProofs().filter((proof) => proof.threadId === threadId);
    const proofArtifactPaths = new Set(queuedProofArtifactPaths.filter(Boolean));
    for (const proof of previewProofs) {
      for (const artifact of proof.verification.artifacts) {
        if (!artifact.filePath || artifact.availability !== "available") {
          continue;
        }
        proofArtifactPaths.add(artifact.filePath);
      }
      this.store.removePreviewProof(proof.id);
    }
    for (const proofArtifactPath of proofArtifactPaths) {
      const filePath = path.resolve(proofArtifactPath);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      removed.add(filePath);
      await this.pruneArtifactParents(filePath);
    }

    if (cwd) {
      const cleanupCount = await cleanupManagedWorktree(cwd).catch(() => 0);
      for (let index = 0; index < cleanupCount; index += 1) {
        removed.add(`worktree-cleanup:${threadId}:${index}`);
      }
    }

    return removed.size;
  }

  private async pruneArtifactParents(filePath: string): Promise<void> {
    if (!this.artifactsDir) {
      return;
    }
    let current = path.dirname(path.resolve(filePath));
    while (current.startsWith(`${this.artifactsDir}${path.sep}`) && current !== this.artifactsDir) {
      try {
        await fs.rmdir(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }

  private buildThreadDeleteContext(threadId: string): ThreadDeleteContext {
    const thread = this.store.getThread(threadId);

    return {
      threadId,
      cwd: thread?.cwd ?? null,
      threadCreatedAt: normalizeTimestampMs(thread?.createdAt),
      stacks: this.store.listStackLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        retainsVolumes: Boolean(lease.retainsVolumes),
        status: lease.status
      })),
      previews: this.store.listPreviewLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        stackId: lease.stackId,
        status: lease.status
      })),
      services: this.store.listServiceLeases().filter((lease) => lease.threadId === threadId).map((lease) => ({
        id: lease.id,
        stackId: lease.stackId,
        runtimeKind: lease.runtimeKind,
        status: lease.status
      })),
      proofArtifactPaths: this.listThreadProofArtifactPaths(threadId)
    };
  }

  private async unsubscribeThread(threadId: string): Promise<void> {
    await this.codexProviderAdapter.unsubscribeThread(threadId).catch(() => undefined);
    this.resumedThreadIds.delete(threadId);
    this.directControlThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
  }

  private scheduleCleanupQueue(): void {
    void this.processPendingCleanupTasks().catch(() => undefined);
  }

  private nextCleanupRetryDelayMs(attempts: number): number {
    const cappedAttempts = Math.max(1, Math.min(attempts, 6));
    return Math.min(15 * 60 * 1000, 30_000 * 2 ** (cappedAttempts - 1));
  }

  async processPendingCleanupTasks(): Promise<void> {
    if (this.cleanupQueueRunning) {
      return;
    }

    this.cleanupQueueRunning = true;
    try {
      for (const task of this.store.listDueRuntimeCleanupTasks()) {
        try {
          await this.onThreadDeleting?.({
            threadId: task.threadId,
            cwd: task.cwd,
            threadCreatedAt: task.threadCreatedAt ?? null,
            stacks: task.stacks,
            previews: task.previews,
            services: task.services
          });
          await this.deleteThreadArtifacts(task.threadId, task.cwd, task.threadCreatedAt ?? null, task.proofArtifactPaths ?? []);
          this.store.completeRuntimeCleanupTask(task.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const nextAttemptAt = Date.now() + this.nextCleanupRetryDelayMs(task.attempts + 1);
          const failed = this.store.failRuntimeCleanupTask(task.id, message, nextAttemptAt);
          if (failed.notify) {
            this.onRuntimeCleanupError?.(task.threadId, message);
          }
        }
      }
    } finally {
      this.cleanupQueueRunning = false;
    }
  }

  async deleteThread(threadId: string, options: { waitForCleanup?: boolean } = {}): Promise<{ deletedArtifacts: number; cleanupFailed?: boolean; cleanupError?: string | null }> {
    const context = this.buildThreadDeleteContext(threadId);
    await this.memoryScheduler?.beforeThreadDelete(context);
    if (options.waitForCleanup) {
      try {
        await this.onThreadDeleting?.({ threadId: context.threadId, cwd: context.cwd, threadCreatedAt: context.threadCreatedAt, stacks: context.stacks, previews: context.previews, services: context.services });
        const deletedArtifacts = await this.deleteThreadArtifacts(context.threadId, context.cwd, context.threadCreatedAt);
        this.deletedThreadIds.add(threadId);
        this.store.removeThread(threadId);
        await this.onThreadCapabilityRemoved?.(threadId);
        this.emit("change");
        await this.unsubscribeThread(threadId);
        return { deletedArtifacts, cleanupFailed: false, cleanupError: null };
      } catch (error) {
        return { deletedArtifacts: 0, cleanupFailed: true, cleanupError: error instanceof Error ? error.message : String(error) };
      }
    }

    this.store.enqueueRuntimeCleanupTask({ threadId: context.threadId, cwd: context.cwd, threadCreatedAt: context.threadCreatedAt, stacks: context.stacks, previews: context.previews, services: context.services, proofArtifactPaths: context.proofArtifactPaths });
    this.deletedThreadIds.add(threadId);
    this.store.removeThread(threadId);
    this.scheduleCleanupQueue();
    await this.onThreadCapabilityRemoved?.(threadId);
    this.emit("change");
    await this.unsubscribeThread(threadId);
    this.scheduleCleanupQueue();
    return { deletedArtifacts: 0, cleanupFailed: false, cleanupError: null };
  }

  async deleteAllThreads(): Promise<{ deletedThreadIds: string[]; deletedArtifacts: number }> {
    const threadIds = this.store.listThreads().map((thread) => thread.id);
    const deleteContexts = threadIds.map((threadId) => this.buildThreadDeleteContext(threadId));
    await this.memoryScheduler?.beforeThreadsDelete(deleteContexts);
    for (const context of deleteContexts) {
      this.store.enqueueRuntimeCleanupTask({ threadId: context.threadId, cwd: context.cwd, threadCreatedAt: context.threadCreatedAt, stacks: context.stacks, previews: context.previews, services: context.services, proofArtifactPaths: context.proofArtifactPaths });
    }
    for (const threadId of threadIds) {
      this.deletedThreadIds.add(threadId);
    }
    this.store.removeThreads(threadIds);
    this.scheduleCleanupQueue();
    for (const threadId of threadIds) {
      await this.onThreadCapabilityRemoved?.(threadId);
    }
    this.emit("change");
    for (const threadId of threadIds) {
      await this.unsubscribeThread(threadId);
    }
    return { deletedThreadIds: threadIds, deletedArtifacts: 0 };
  }
}
