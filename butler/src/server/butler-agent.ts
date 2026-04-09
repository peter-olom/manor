import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { complete, getModel, type Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSession
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";

import { readButlerAuthStatus } from "./auth-status.js";
import { buildOnboardingView } from "./onboarding-status.js";
import { type ImageReferenceStore } from "./image-store.js";
import { decoratePreviewVerification } from "./preview-verification.js";
import { ensureTaskWorktree, resolveExistingWorkspaceCwd, resolveWorkspaceProjectInfo } from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import { buildThreadExecutionContract, describeExecutionMode, detectExecutionMode } from "./thread-contract.js";
import {
  applyWorkspacePreviewDefaults,
  formatWorkspaceBootstrapLines,
  inspectWorkspaceBootstrap
} from "./workspace-bootstrap.js";
import type {
  AppSnapshot,
  AppShellSnapshot,
  ButlerLiveSnapshot,
  ButlerAuthStatus,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerOnboardingView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  ButlerToolView,
  CodexThreadExecutionContractView,
  ModelOption
} from "./types.js";
import { ButlerStateStore } from "./state-store.js";
import { CodexAppServerClient } from "./codex-client.js";
import type { PreviewLeaseView, PreviewProofRecordView, PreviewVerificationArtifactView, PreviewVerificationView } from "./types.js";

type ProofScreenshotReview = {
  verdict: string;
  visibleState: string;
  evidence: string;
  concern: string;
  rawText: string;
  reviewedAt: number;
  modelId: string;
  modelProvider: string;
};

type ResolvedPreviewProof = {
  preview: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId">;
  verification: PreviewVerificationView;
  screenshot: PreviewVerificationArtifactView;
  video: PreviewVerificationArtifactView | null;
  manifest: PreviewVerificationArtifactView | null;
  trace: PreviewVerificationArtifactView | null;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractMessageTimestamp(message: Record<string, unknown>): number | null {
  const candidates = [message.timestamp, message.createdAt, message.at];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function extractWorkspaceMentions(text: string): string[] {
  const matches = text.match(/\/repos(?:\/\.manor-worktrees)?\/[^\s`"'()<>{}\]]+/g) ?? [];
  return [...new Set(matches.map((entry) => entry.replace(/[.,;:!?]+$/g, "")))];
}

function serializeMessages(session: AgentSession): ButlerMessageView[] {
  const messages = session.messages
    .map((message, index) => {
      const role = "role" in message && typeof message.role === "string" ? message.role : "unknown";
      const record = message as unknown as Record<string, unknown>;
      const text =
        "content" in message && contentToText(message.content).trim()
          ? contentToText(message.content)
          : typeof record.errorMessage === "string"
            ? record.errorMessage
            : "";
      return {
        id: `message-${index}`,
        role,
        text,
        at: extractMessageTimestamp(record),
        kind: "message" as const
      };
    });

  return messages.filter((message, index) => {
    if (!(message.role === "user" || message.role === "assistant" || message.role === "user-with-attachments")) {
      return false;
    }

    if (message.role === "assistant" && !message.text.trim()) {
      return false;
    }

    return true;
  });
}

function isAssistantFailureMessage(message: unknown): message is Record<string, unknown> & {
  role: "assistant";
  stopReason: "error" | "aborted";
  errorMessage?: string;
} {
  if (!message || typeof message !== "object") {
    return false;
  }

  const record = message as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    (record.stopReason === "error" || record.stopReason === "aborted") &&
    (typeof record.errorMessage === "string" || !("errorMessage" in record))
  );
}

function sanitizeHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }

  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : null;
  if (role !== "user" && role !== "user-with-attachments") {
    return { message, changed: false };
  }

  const content = record.content;
  if (!Array.isArray(content)) {
    return { message, changed: false };
  }

  let removedImage = false;
  const nextContent: Record<string, unknown>[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      nextContent.push({ type: "text", text: String(entry ?? "") });
      continue;
    }

    const part = entry as Record<string, unknown>;
    if (part.type === "image") {
      removedImage = true;
      continue;
    }

    nextContent.push({ ...part });
  }

  if (!removedImage) {
    return { message, changed: false };
  }

  nextContent.push({
    type: "text",
    text: "[Attached image omitted from persisted Butler history.]"
  });

  return {
    changed: true,
    message: {
      ...record,
      role: "user",
      content: nextContent
    }
  };
}

function sanitizeHistoryMessages(messages: AgentMessage[]): { messages: AgentMessage[]; changed: boolean } {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const sanitized = sanitizeHistoryMessage(message);
    if (sanitized.changed) {
      changed = true;
    }
    return sanitized.message as AgentMessage;
  });

  return { messages: changed ? nextMessages : messages, changed };
}

function buildJobsSummary(store: ButlerStateStore, limit: number, status?: string): string {
  const jobs = store
    .listThreads()
    .filter((thread) => !status || thread.status === status)
    .slice(0, limit);

  if (jobs.length === 0) {
    return "No jobs matched that filter.";
  }

  return jobs
    .map(
      (thread, index) =>
        `${index + 1}. ${thread.id} | project=${thread.supervisor.projectLabel} | status=${thread.status} | source=${thread.source} | updated=${new Date(thread.updatedAt).toISOString()} | preview=${thread.preview || "(empty)"} | summary=${thread.supervisor.summary}`
    )
    .join("\n");
}

function buildJobDetail(store: ButlerStateStore, threadId: string): string {
  const thread = store.getThread(threadId);
  if (!thread) {
    return `Job ${threadId} was not found.`;
  }
  const lease = store.getThreadPreviewLease(threadId);

  const turns = thread.turns
    .map((turn, turnIndex) => {
      const items = turn.items
        .map((item, itemIndex) => `${turnIndex + 1}.${itemIndex + 1} ${item.type} (${item.status}) ${item.text}`.trim())
        .join("\n");
      return `Turn ${turnIndex + 1} | id=${turn.id} | status=${turn.status}\n${items}`;
    })
    .join("\n\n");

  return [
    `Job ${thread.id}`,
    `project=${thread.supervisor.projectLabel}`,
    `status=${thread.status}`,
    `source=${thread.source}`,
    `preview=${thread.preview || "(empty)"}`,
    lease ? `operator_preview=${lease.operatorUrl}` : "operator_preview=(none)",
    `summary=${thread.supervisor.summary}`,
    turns || "No turn details loaded yet."
  ].join("\n");
}

function buildProjectsSummary(store: ButlerStateStore, limit: number): string {
  const projects = store.listProjectSummaries().slice(0, limit);
  if (projects.length === 0) {
    return "No projects are active yet.";
  }

  return projects
    .map(
      (project, index) =>
        `${index + 1}. ${project.label} | threads=${project.threadCount} | active=${project.activeCount} | blocked=${project.blockedCount} | updated=${new Date(project.updatedAt).toISOString()} | summary=${project.summary}`
    )
    .join("\n");
}

function buildProjectDetail(store: ButlerStateStore, projectId: string): string {
  const project = store.getProjectSummary(projectId);
  if (!project) {
    return `Project ${projectId} was not found.`;
  }

  const threadLines = project.threadIds
    .map((threadId, index) => {
      const thread = store.getThread(threadId);
      if (!thread) {
        return null;
      }

      return `${index + 1}. ${thread.id} | status=${thread.status} | summary=${thread.supervisor.summary}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `Project ${project.label}`,
    `threads=${project.threadCount}`,
    `active=${project.activeCount}`,
    `blocked=${project.blockedCount}`,
    `idle=${project.completedCount}`,
    `summary=${project.summary}`,
    threadLines || "No thread details loaded yet."
  ].join("\n");
}

function buildSupervisorOverview(store: ButlerStateStore): string {
  const summary = store.getSupervisorSummary();
  const leadProjects = store
    .listProjectSummaries()
    .slice(0, 5)
    .map((project, index) => `${index + 1}. ${project.label} | ${project.summary}`)
    .join("\n");

  return [summary.summary, leadProjects].filter(Boolean).join("\n");
}

function normalizeNoticeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function summarizeNoticeResult(value: string | null | undefined): string | null {
  const normalized = normalizeNoticeText(value);
  if (!normalized) {
    return null;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return normalized;
  }

  const first = sentences[0];
  if (first.length >= 24 || sentences.length === 1) {
    return first;
  }

  return `${first} ${sentences[1] ?? ""}`.trim();
}

function extractLatestNoticeTexts(thread: ReturnType<ButlerStateStore["getThread"]>) {
  if (!thread) {
    return {
      latestUserPrompt: null as string | null,
      latestAgentReply: null as string | null
    };
  }

  const flattenedItems = thread.turns.flatMap((turn) => turn.items);
  const latestUserPrompt =
    normalizeNoticeText([...flattenedItems].reverse().find((item) => item.type === "userMessage" && item.text.trim())?.text) ?? null;
  const latestAgentReply =
    normalizeNoticeText([...flattenedItems].reverse().find((item) => item.type === "agentMessage" && item.text.trim())?.text) ?? null;

  return { latestUserPrompt, latestAgentReply };
}

function buildMilestoneNoticeText(
  store: ButlerStateStore,
  milestone: { type: "completed" | "blocked"; threadId: string; turnId: string; summary: string }
): string | null {
  const thread = store.getThread(milestone.threadId);
  if (!thread) {
    return null;
  }

  const workerReport = store.getWorkerReport(milestone.threadId, milestone.turnId);
  if (workerReport && workerReport.status === milestone.type) {
    const prefix =
      milestone.type === "blocked"
        ? `Codex needs attention on ${thread.supervisor.projectLabel}.`
        : `Codex finished work on ${thread.supervisor.projectLabel}.`;
    return [prefix, workerReport.summary, workerReport.details].filter(Boolean).join("\n\n");
  }
  return null;
}

function buildSystemPrompt(store: ButlerStateStore): string {
  const supervisor = store.getSupervisorSummary();
  const projects = store.listProjectSummaries().slice(0, 8);

  return [
    "You are Butler, the supervisor inside Manor.",
    "Keep the main Butler chat operator-facing and concise.",
    "Use Codex project and thread summaries as your background memory.",
    "Do not expose private Butler-to-Codex steering verbatim in the Butler chat.",
    "If the operator asks for real execution, project setup, repository cloning, coding work, or shell work, delegate it to Codex instead of replying with manual shell instructions.",
    "When Codex work changes state, summarize the outcome rather than replaying the full back-and-forth.",
    "Each supervised Codex thread has a Butler steering budget. Default to 20 Butler-driven turns per thread unless that thread is explicitly overridden.",
    "When work touches git in a repo, enforce a dedicated branch whose name starts with butler/.",
    "Do not run two parallel Codex workstreams on the same repo branch.",
    "When a task needs multiple cooperating previews or disposable services, create a stack lease first so Butler can keep the whole environment under one isolated network and lifecycle.",
    "For recurring mutable databases or object stores, prefer job-scoped stateful stacks so each job gets its own retained writable copy forked from the project base by default.",
    "Reserve base-mode stacks for intentional seed or snapshot refresh work. Do not let multiple jobs share one writable database volume.",
    "When a task needs a live app review, prefer a preview lease on an isolated runtime instead of telling the operator to bind a raw host port.",
    "When preview bootstrap is unclear, inspect the workspace bootstrap hints before deciding on image, egress, or install steps.",
    "When a project needs common dev dependencies like Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite, prefer the built-in service templates instead of ad hoc install steps.",
    "Choose an execution mode explicitly before delegating or steering Codex: local Manor branch runtime or live deployed runtime.",
    "When the operator asks to check out a branch, worktree, or repo and produce proof, default to local Manor branch runtime unless the operator explicitly asks for live, staging, or production verification.",
    "Do not silently substitute live deployed verification for local branch verification.",
    "If the needed execution mode changes, start a fresh Codex workstream instead of reusing an older thread with a different strategy.",
    "For local Manor runtime tasks that involve signup or email flows, prefer built-in local services like Mailpit when the app under test is running inside Manor.",
    "Codex may operate inside attached isolates through manor-harness for inspect, logs, processes, and shell exec, but Butler still owns isolate lifecycle and policy.",
    "When the operator provides reference images, keep track of the stored image references so you can pass them to Codex later and reuse them during verification.",
    "Use the image reference tools whenever visual requirements depend on an uploaded image.",
    "When proof of frontend execution is requested, do not accept artifact existence alone as proof. Run headed verification when needed, inspect the screenshot with the proof review tool, and surface the video download for human review.",
    "Never reuse or mention a deleted, unknown, or cwd-less Codex thread as if it were a valid workstream.",
    "",
    `Supervisor state: ${supervisor.summary}`,
    projects.length > 0 ? "Project summaries:" : "Project summaries: none yet.",
    ...projects.map((project) => `- ${project.label}: ${project.summary}`)
  ].join("\n");
}

function findVerificationArtifact(
  verification: PreviewVerificationView | null | undefined,
  kind: PreviewVerificationArtifactView["kind"]
): PreviewVerificationArtifactView | null {
  if (!verification) {
    return null;
  }

  return verification.artifacts.find((artifact) => artifact.kind === kind) ?? null;
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseProofScreenshotReview(rawText: string): ProofScreenshotReview | null {
  const payload = stripMarkdownCodeFence(rawText);
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<ProofScreenshotReview>;
    const parsedEvidence = (parsed as { evidence?: unknown }).evidence;
    const evidence =
      typeof parsedEvidence === "string"
        ? parsedEvidence
        : Array.isArray(parsedEvidence)
          ? parsedEvidence
              .map((entry: unknown) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean)
              .join(" ")
          : null;
    if (
      typeof parsed.verdict !== "string" ||
      typeof parsed.visibleState !== "string" ||
      typeof evidence !== "string" ||
      typeof parsed.concern !== "string"
    ) {
      return null;
    }

    return {
      verdict: parsed.verdict.trim(),
      visibleState: parsed.visibleState.trim(),
      evidence: evidence.trim(),
      concern: parsed.concern.trim(),
      rawText: payload,
      reviewedAt: Date.now(),
      modelId: "",
      modelProvider: ""
    };
  } catch {
    return null;
  }
}

function mergeVisibleMessages(sessionMessages: ButlerMessageView[], notices: ButlerMessageView[]): ButlerMessageView[] {
  return [...sessionMessages, ...notices].sort((left, right) => {
    const leftAt = left.at ?? 0;
    const rightAt = right.at ?? 0;
    if (leftAt === rightAt) {
      return left.id.localeCompare(right.id);
    }
    return leftAt - rightAt;
  });
}

const SNAPSHOT_MESSAGE_TAIL_LIMIT = 200;
const MAX_HISTORY_PAGE_SIZE = 1000;

export class ButlerAgentService extends EventEmitter {
  private readonly store: ButlerStateStore;
  private readonly codexClient: CodexAppServerClient;
  private readonly runtimeBroker: RuntimeBrokerClient;
  private readonly serviceTemplates: LoadedServiceTemplate[];
  private readonly imageStore: ImageReferenceStore;
  private readonly piAuthPath: string;
  private readonly codexAuthPath: string;
  private readonly codexConfigDir: string;
  private readonly sessionDir: string;
  private readonly noticeStatePath: string;
  private readonly refreshRuntimeInventory: (() => Promise<void>) | null;
  private modelRegistry: ModelRegistry | null = null;
  private session: AgentSession | null = null;
  private auth: ButlerAuthStatus = { mode: "none", loggedIn: false };
  private onboarding: ButlerOnboardingView = {
    complete: false,
    steps: []
  };
  private ready = false;
  private pending = false;
  private lastError: string | null = null;
  private promptQueue: Promise<void> = Promise.resolve();
  private readonly toolCatalog: ButlerToolView[];
  private unsubscribeSession: (() => void) | null = null;
  private statusRefreshTimer: NodeJS.Timeout | null = null;
  private readonly noticeMessages: ButlerMessageView[] = [];
  private readonly seenMilestoneIds = new Set<string>();
  private compaction: Omit<ButlerCompactionView, "autoEnabled" | "active" | "count"> = {
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastTokensBefore: null,
    lastWillRetry: false,
    lastAborted: false,
    lastError: null
  };

  constructor(options: {
    store: ButlerStateStore;
    codexClient: CodexAppServerClient;
    runtimeBroker: RuntimeBrokerClient;
    serviceTemplates: LoadedServiceTemplate[];
    imageStore: ImageReferenceStore;
    piAuthPath: string;
    codexAuthPath: string;
    codexConfigDir: string;
    sessionDir: string;
    refreshRuntimeInventory?: () => Promise<void>;
  }) {
    super();
    this.store = options.store;
    this.codexClient = options.codexClient;
    this.runtimeBroker = options.runtimeBroker;
    this.serviceTemplates = options.serviceTemplates;
    this.imageStore = options.imageStore;
    this.piAuthPath = options.piAuthPath;
    this.codexAuthPath = options.codexAuthPath;
    this.codexConfigDir = options.codexConfigDir;
    this.sessionDir = options.sessionDir;
    this.refreshRuntimeInventory = options.refreshRuntimeInventory ?? null;
    this.noticeStatePath = path.join(this.sessionDir, "notices.json");
    this.toolCatalog = this.buildToolCatalog();
  }

  private async refreshRuntimeInventoryIfAvailable(): Promise<string | null> {
    if (!this.refreshRuntimeInventory) {
      return null;
    }

    try {
      await this.refreshRuntimeInventory();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async loadNoticeState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.noticeStatePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      this.noticeMessages.splice(0, this.noticeMessages.length);
      for (const item of parsed) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const id = typeof item.id === "string" ? item.id : null;
        const role = typeof item.role === "string" ? item.role : null;
        const text = typeof item.text === "string" ? item.text : null;
        const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : null;
        const kind = item.kind === "notice" ? "notice" : null;

        if (!id || !role || !text || !kind) {
          continue;
        }

        this.noticeMessages.push({ id, role, text, at, kind });
        if (id.startsWith("notice-")) {
          this.seenMilestoneIds.add(id.slice("notice-".length));
        }
      }

      this.noticeMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.noticeMessages.length > 40) {
        this.noticeMessages.splice(0, this.noticeMessages.length - 40);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async saveNoticeState(): Promise<void> {
    await fs.writeFile(this.noticeStatePath, JSON.stringify(this.noticeMessages, null, 2), "utf8");
  }

  private handleStoreChange(): void {
    let changed = false;

    for (const milestone of this.store.listMilestones()) {
      if (milestone.type !== "completed" && milestone.type !== "blocked") {
        continue;
      }

      const noticeMilestone = milestone as typeof milestone & { type: "completed" | "blocked" };
      const noticeId = `notice-${milestone.id}`;
      const nextText = buildMilestoneNoticeText(this.store, noticeMilestone);
      const existingNotice = this.noticeMessages.find((entry) => entry.id === noticeId);

      if (!nextText) {
        if (existingNotice) {
          const index = this.noticeMessages.findIndex((entry) => entry.id === noticeId);
          if (index >= 0) {
            this.noticeMessages.splice(index, 1);
          }
          changed = true;
        }
        continue;
      }

      if (this.seenMilestoneIds.has(milestone.id)) {
        if (existingNotice && existingNotice.text !== nextText) {
          existingNotice.text = nextText;
          changed = true;
        } else if (!existingNotice) {
          this.noticeMessages.push({
            id: noticeId,
            role: "assistant",
            text: nextText,
            at: milestone.at,
            kind: "notice" as const
          });
          changed = true;
        }
        continue;
      }

      this.seenMilestoneIds.add(milestone.id);
      this.noticeMessages.push({
        id: noticeId,
        role: "assistant",
        text: nextText,
        at: milestone.at,
        kind: "notice" as const
      });
      changed = true;
    }

    if (changed) {
      this.noticeMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.noticeMessages.length > 40) {
        this.noticeMessages.splice(0, this.noticeMessages.length - 40);
      }
      void this.saveNoticeState();
      this.emit("change");
    }
  }

  async start(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    await this.loadNoticeState();
    this.auth = await readButlerAuthStatus(this.piAuthPath);
    this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
    await this.createOrRefreshSession();
    await this.refreshExternalStatus();
    this.store.on("change", () => this.handleStoreChange());
    this.handleStoreChange();
    this.statusRefreshTimer = setInterval(() => {
      void this.refreshExternalStatus();
    }, 10000);

    this.ready = true;
    this.emit("change");
  }

  private async refreshExternalStatus(): Promise<void> {
    const nextAuth = await readButlerAuthStatus(this.piAuthPath);
    const authChanged = nextAuth.mode !== this.auth.mode || nextAuth.loggedIn !== this.auth.loggedIn;

    if (authChanged) {
      this.auth = nextAuth;
      this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
      await this.createOrRefreshSession();
    }

    const nextOnboarding = await buildOnboardingView({
      butlerAuth: this.auth,
      codexAuthPath: this.codexAuthPath,
      codexConfigDir: this.codexConfigDir
    });

    if (JSON.stringify(nextOnboarding) !== JSON.stringify(this.onboarding) || authChanged) {
      this.onboarding = nextOnboarding;
      this.emit("change");
    }
  }

  // This is the single discoverable registry for Butler actions and their UI
  // side effects. Keep agent tool definitions aligned with this catalog.
  private buildToolCatalog(): ButlerToolView[] {
    return [
      {
        name: "prepare_worktree",
        label: "Prepare worktree",
        description: "Create a dedicated butler/ branch and isolated git worktree for one repo task.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps thread/project state aligned with worktree-backed tasks." }]
      },
      {
        name: "start_stack",
        label: "Start stack",
        description: "Create one isolated stack lease and network for a multi-container job.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps stack-backed job state current." }]
      },
      {
        name: "list_stacks",
        label: "List stacks",
        description: "List active stack leases and their isolated networks.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps stack lease state current." }]
      },
      {
        name: "inspect_stack",
        label: "Inspect stack",
        description: "Inspect one stack lease, including its current member counts and network.",
        uiEffects: [{ kind: "refreshThreads", description: "Refreshes one stack lease before Butler acts on it." }]
      },
      {
        name: "promote_stack",
        label: "Promote stack",
        description: "Copy a stack's retained volumes into another storage namespace.",
        uiEffects: [{ kind: "refreshThreads", description: "Refreshes stack storage state after promotion." }]
      },
      {
        name: "stop_stack",
        label: "Stop stack",
        description: "Stop one stack lease, remove its members, and release its isolated network.",
        uiEffects: [{ kind: "refreshThreads", description: "Removes stale stack state from the supervised job." }]
      },
      {
        name: "start_preview",
        label: "Start preview",
        description: "Start a disposable preview runtime for one worktree and expose it through a stable Manor route.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps preview-backed job state current." }]
      },
      {
        name: "stop_preview",
        label: "Stop preview",
        description: "Stop one preview runtime and release its route.",
        uiEffects: [{ kind: "refreshThreads", description: "Removes stale preview state from the supervised job." }]
      },
      {
        name: "list_previews",
        label: "List previews",
        description: "List active preview leases and their operator-facing routes.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps preview lease state current." }]
      },
      {
        name: "inspect_preview",
        label: "Inspect preview",
        description: "Inspect one preview runtime, including its current runtime state and egress configuration.",
        uiEffects: [{ kind: "refreshThreads", description: "Refreshes one preview lease before Butler acts on it." }]
      },
      {
        name: "verify_preview",
        label: "Verify preview",
        description: "Run Playwright verification for one preview and persist screenshot, video, trace, and manifest artifacts.",
        uiEffects: [{ kind: "refreshThreads", description: "Refreshes preview proof state after a verification run." }]
      },
      {
        name: "review_preview_proof",
        label: "Review preview proof",
        description: "Inspect the latest screenshot proof for one preview or job and surface the video download for human review.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while reviewing proof artifacts." }]
      },
      {
        name: "preview_processes",
        label: "Preview processes",
        description: "List processes running inside one preview isolate.",
        uiEffects: [{ kind: "refreshThreads", description: "Lets Butler confirm what is actually running inside an isolate." }]
      },
      {
        name: "preview_logs",
        label: "Preview logs",
        description: "Read recent logs from one preview isolate.",
        uiEffects: [{ kind: "refreshThreads", description: "Lets Butler inspect isolate output without opening a shell." }]
      },
      {
        name: "exec_preview",
        label: "Exec in preview",
        description: "Run one shell command inside a preview isolate through the runtime broker.",
        uiEffects: [{ kind: "refreshThreads", description: "Lets Butler actively diagnose or fix one preview isolate." }]
      },
      {
        name: "list_service_templates",
        label: "List service templates",
        description: "List the built-in Manor service templates Butler can provision for app stacks.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while choosing a service template." }]
      },
      {
        name: "start_service",
        label: "Start service",
        description: "Provision a disposable built-in service such as Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite for one job.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps service-backed job state current." }]
      },
      {
        name: "list_services",
        label: "List services",
        description: "List active disposable services and their connection details.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps service lease state current." }]
      },
      {
        name: "inspect_service",
        label: "Inspect service",
        description: "Inspect one service runtime and return its current connection details and runtime state.",
        uiEffects: [{ kind: "refreshThreads", description: "Refreshes one service lease before Butler acts on it." }]
      },
      {
        name: "service_logs",
        label: "Service logs",
        description: "Read recent logs from one container-backed service runtime.",
        uiEffects: [{ kind: "refreshThreads", description: "Lets Butler inspect one service without opening a shell." }]
      },
      {
        name: "exec_service",
        label: "Exec in service",
        description: "Run one shell command inside a container-backed service runtime.",
        uiEffects: [{ kind: "refreshThreads", description: "Lets Butler inspect or patch one service directly." }]
      },
      {
        name: "stop_service",
        label: "Stop service",
        description: "Stop one disposable service runtime and release its lease.",
        uiEffects: [{ kind: "refreshThreads", description: "Removes stale service state from the supervised job." }]
      },
      {
        name: "list_jobs",
        label: "List jobs",
        description: "List Codex jobs, their statuses, and short previews.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps the run list current." }]
      },
      {
        name: "list_image_references",
        label: "List image references",
        description: "List stored image references Butler can reuse for delegation and verification.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while choosing stored reference images." }]
      },
      {
        name: "read_job",
        label: "Read job",
        description: "Read a Codex job in detail, including loaded turns and messages.",
        uiEffects: [{ kind: "refreshThread", description: "Loads the latest run transcript into Butler." }]
      },
      {
        name: "list_projects",
        label: "List projects",
        description: "List repo-level Codex supervision summaries so Butler can stay on top of many threads.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while checking project activity." }]
      },
      {
        name: "read_project",
        label: "Read project",
        description: "Read the current summary for one project and its tracked Codex threads.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while inspecting one project." }]
      },
      {
        name: "supervisor_overview",
        label: "Supervisor overview",
        description: "Return the top-level supervisor summary across all tracked Codex projects and threads.",
        uiEffects: [{ kind: "focusButler", description: "Keeps Butler anchored in the main supervisor thread." }]
      },
      {
        name: "delegate_to_codex",
        label: "Delegate to Codex",
        description: "Start a new Codex workstream for an execution task such as repo cloning, project setup, coding work, or command execution.",
        uiEffects: [
          { kind: "openWindow", description: "Opens the delegated Codex workstream as a tab." },
          { kind: "focusWindow", description: "Moves focus into the new Codex workstream." }
        ]
      },
      {
        name: "open_job_window",
        label: "Open job window",
        description: "Open a focused job window in the Butler UI for a specific Codex job.",
        uiEffects: [
          { kind: "openWindow", description: "Opens the selected run as a tab." },
          { kind: "focusWindow", description: "Moves Butler focus into that run." }
        ]
      },
      {
        name: "list_open_windows",
        label: "List open windows",
        description: "List the windows currently open in the Butler UI.",
        uiEffects: [{ kind: "focusButler", description: "Stays in supervisor mode while checking current tabs." }]
      },
      {
        name: "message_job",
        label: "Message job",
        description: "Privately send a follow-up instruction into one Codex job thread without surfacing the full steering text in Butler chat.",
        uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run after Butler steers it." }]
      },
      {
        name: "delete_job",
        label: "Delete job",
        description: "Permanently delete one Codex job thread and its local session artifacts.",
        uiEffects: [
          { kind: "removeThread", description: "Removes the run from the list." },
          { kind: "removeThreads", description: "Closes any open tab tied to that run." }
        ]
      },
      {
        name: "delete_all_jobs",
        label: "Delete all jobs",
        description: "Permanently delete all Codex job threads and their local session artifacts.",
        uiEffects: [
          { kind: "removeThreads", description: "Clears the run list and closes all run tabs." },
          { kind: "focusButler", description: "Returns the UI to Butler after cleanup." }
        ]
      }
    ];
  }

  private defineButlerTool<TParams extends Record<string, unknown>>(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: TSchema;
    uiEffects: ButlerToolUiEffect[];
    execute: (toolCallId: string, params: TParams) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
  }) {
    return defineTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.promptSnippet,
      parameters: definition.parameters,
      execute: async (toolCallId, params) => {
        const result = await definition.execute(toolCallId, params as TParams);
        return {
          ...result,
          details: {
            ...(result.details ?? {}),
            uiEffects: definition.uiEffects
          }
        };
      }
    });
  }

  private getThreadBudgetLimitMessage(threadId: string): string | null {
    const supervision = this.store.getThreadSupervision(threadId);
    if (supervision.maxButlerTurns === null || supervision.butlerTurnsUsed < supervision.maxButlerTurns) {
      return null;
    }

    return `Butler has reached the supervision limit for job ${threadId}. Used ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns} Butler turns. Raise the limit on that thread before asking Butler to steer it again.`;
  }

  private async prepareDelegationWorkspace(task: string, cwd?: string): Promise<{ cwd: string; branchName: string | null }> {
    const requestedCwd = cwd ?? "/repos";
    if (cwd) {
      const resolvedCwd = await resolveExistingWorkspaceCwd(cwd);
      if (resolvedCwd && resolvedCwd !== cwd) {
        return {
          cwd: resolvedCwd,
          branchName: null
        };
      }
    }

    const worktree = await ensureTaskWorktree({
      cwd: requestedCwd,
      task
    });

    return {
      cwd: worktree.cwd,
      branchName: worktree.branchName
    };
  }

  private async buildDelegationContract(options: {
    threadId: string;
    task: string;
    goal?: string;
    workspace: { cwd: string; branchName: string | null };
  }): Promise<{ text: string; contract: CodexThreadExecutionContractView }> {
    const requestedTask = options.goal ? `${options.task}\n\nGoal: ${options.goal}` : options.task;
    const project = resolveWorkspaceProjectInfo(options.workspace.cwd);
    const notes = ["Treat this contract as authoritative over any older worktree or cwd hints in the task text."];
    const workspaceMentions = extractWorkspaceMentions(requestedTask).filter((entry) => entry !== options.workspace.cwd);

    for (const mention of workspaceMentions) {
      const resolvedMention = await resolveExistingWorkspaceCwd(mention);
      const mentionExists = await fs.access(resolvedMention).then(() => true).catch(() => false);
      if (!mentionExists) {
        notes.push(`Ignore stale workspace hint ${mention}. Use ${options.workspace.cwd} instead.`);
        continue;
      }
      if (resolvedMention !== mention && resolvedMention === options.workspace.cwd) {
        notes.push(`The task referenced ${mention}, but the live workspace resolves to ${options.workspace.cwd}.`);
      }
    }

    const contract = buildThreadExecutionContract({
      threadId: options.threadId,
      workspaceCwd: options.workspace.cwd,
      projectId: project.id,
      projectLabel: project.label,
      branch: options.workspace.branchName,
      taskText: requestedTask,
      notes
    });
    const lines = [
      "AUTHORITATIVE JOB CONTRACT",
      `thread_id: ${options.threadId}`,
      `workspace_cwd: ${options.workspace.cwd}`,
      `project_id: ${project.id}`,
      `project_label: ${project.label}`,
      `branch: ${options.workspace.branchName ?? "(existing workspace)"}`,
      `execution_mode: ${contract.executionModeLabel}`,
      `harness_binding: manor-harness --thread ${options.threadId}`,
      `preview_lane: ${contract.previewLane === "expected" ? "expected when runtime validation is needed" : "available on demand"}`
    ];

    for (const note of notes) {
      lines.push(`note: ${note}`);
    }

    return {
      text: `${lines.join("\n")}\n\nREQUESTED TASK\n${requestedTask}`,
      contract
    };
  }

  private getServiceTemplate(templateId: string): LoadedServiceTemplate {
    const template = this.serviceTemplates.find((entry) => entry.id === templateId);
    if (!template) {
      throw new Error(`Unknown service template: ${templateId}`);
    }
    return template;
  }

  private getValidatedStack(stackId: string | null, threadId: string | null) {
    if (!stackId) {
      return null;
    }

    const threadStacks = this.store
      .listStackLeases()
      .filter((stack) => stack.status !== "stopped" && (!threadId || stack.threadId === threadId || !stack.threadId));
    const stack =
      threadStacks.find((entry) => entry.id === stackId) ??
      (threadStacks.filter((entry) => entry.title === stackId).length === 1
        ? threadStacks.filter((entry) => entry.title === stackId)[0]
        : null) ??
      (() => {
        const folded = stackId.trim().toLowerCase();
        const matches = threadStacks.filter((entry) => entry.title.trim().toLowerCase() === folded);
        return matches.length === 1 ? matches[0] : null;
      })();
    if (!stack) {
      throw new Error(`Unknown stack: ${stackId}`);
    }

    if (threadId && stack.threadId && stack.threadId !== threadId) {
      throw new Error(`Stack ${stackId} belongs to a different job`);
    }

    return stack;
  }

  private getValidatedPreview(previewSelector: string | null, threadId: string | null) {
    if (!previewSelector) {
      return null;
    }

    const threadPreviews = this.store
      .listPreviewLeases()
      .filter((preview) => preview.status !== "stopped" && (!threadId || preview.threadId === threadId || !preview.threadId));
    const directIdMatch = threadPreviews.find((entry) => entry.id === previewSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadPreviews.filter((entry) => entry.title === previewSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadPreviews.filter((entry) => entry.aliases.includes(previewSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const folded = previewSelector.trim().toLowerCase();
    const foldedTitleMatches = threadPreviews.filter((entry) => entry.title.trim().toLowerCase() === folded);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadPreviews.filter((entry) =>
      entry.aliases.some((alias) => alias.trim().toLowerCase() === folded)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    throw new Error(`Unknown preview: ${previewSelector}`);
  }

  private requireValidatedPreview(previewSelector: string, threadId: string | null) {
    const preview = this.getValidatedPreview(previewSelector, threadId);
    if (!preview) {
      throw new Error("Preview selector is required");
    }
    return preview;
  }

  private getValidatedService(serviceSelector: string | null, threadId: string | null) {
    if (!serviceSelector) {
      return null;
    }

    const threadServices = this.store
      .listServiceLeases()
      .filter((service) => service.status !== "stopped" && (!threadId || service.threadId === threadId || !service.threadId));
    const directIdMatch = threadServices.find((entry) => entry.id === serviceSelector);
    if (directIdMatch) {
      return directIdMatch;
    }

    const exactTitleMatches = threadServices.filter((entry) => entry.title === serviceSelector);
    if (exactTitleMatches.length === 1) {
      return exactTitleMatches[0];
    }

    const exactAliasMatches = threadServices.filter((entry) => entry.aliases.includes(serviceSelector));
    if (exactAliasMatches.length === 1) {
      return exactAliasMatches[0];
    }

    const folded = serviceSelector.trim().toLowerCase();
    const foldedTitleMatches = threadServices.filter((entry) => entry.title.trim().toLowerCase() === folded);
    if (foldedTitleMatches.length === 1) {
      return foldedTitleMatches[0];
    }

    const foldedAliasMatches = threadServices.filter((entry) =>
      entry.aliases.some((alias) => alias.trim().toLowerCase() === folded)
    );
    if (foldedAliasMatches.length === 1) {
      return foldedAliasMatches[0];
    }

    throw new Error(`Unknown service: ${serviceSelector}`);
  }

  private requireValidatedService(serviceSelector: string, threadId: string | null) {
    const service = this.getValidatedService(serviceSelector, threadId);
    if (!service) {
      throw new Error("Service selector is required");
    }
    return service;
  }

  private getLatestThreadVerificationPreview(threadId: string): PreviewLeaseView {
    const previews = this.store
      .listPreviewLeases()
      .filter((lease) => lease.threadId === threadId && lease.status !== "stopped");
    if (previews.length === 0) {
      throw new Error(`Job ${threadId} has no active preview.`);
    }

    return [...previews].sort((left, right) => {
      const leftCheckedAt = left.lastVerification?.checkedAt ?? 0;
      const rightCheckedAt = right.lastVerification?.checkedAt ?? 0;
      if (leftCheckedAt !== rightCheckedAt) {
        return rightCheckedAt - leftCheckedAt;
      }
      return right.updatedAt - left.updatedAt;
    })[0]!;
  }

  private toResolvedProof(
    subject: Pick<PreviewLeaseView, "id" | "threadId" | "projectId" | "projectLabel" | "title" | "stackId">,
    verification: PreviewVerificationView,
    runId?: string
  ): ResolvedPreviewProof {
    const decoratedVerification = decoratePreviewVerification(verification);
    if (runId && decoratedVerification.runId !== runId.trim()) {
      throw new Error(`Preview ${subject.id} does not have verification run ${runId.trim()}.`);
    }

    const screenshot = findVerificationArtifact(decoratedVerification, "screenshot");
    if (!screenshot?.filePath) {
      throw new Error(`Preview ${subject.id} has no screenshot artifact to review.`);
    }
    if (screenshot.availability !== "available") {
      throw new Error(
        screenshot.availability === "expired"
          ? `Preview ${subject.id} screenshot proof expired after retention.`
          : `Preview ${subject.id} screenshot proof is no longer available.`
      );
    }

    return {
      preview: subject,
      verification: decoratedVerification,
      screenshot,
      video: findVerificationArtifact(decoratedVerification, "video"),
      manifest: findVerificationArtifact(decoratedVerification, "manifest"),
      trace: findVerificationArtifact(decoratedVerification, "trace")
    };
  }

  private resolvePreviewProof(params: { threadId?: string; leaseId?: string; runId?: string }): ResolvedPreviewProof {
    const preview = params.leaseId ? this.requireValidatedPreview(params.leaseId, params.threadId?.trim() || null) : null;

    if (preview?.lastVerification) {
      return this.toResolvedProof(preview, preview.lastVerification, params.runId);
    }

    const previewProof =
      preview
        ? this.store.getLatestPreviewProofForPreview(preview.id)
        : params.threadId
          ? this.store.getLatestPreviewProofForThread(params.threadId.trim())
          : null;

    if (previewProof) {
      return this.toResolvedProof(
        {
          id: previewProof.previewId,
          threadId: previewProof.threadId,
          projectId: previewProof.projectId,
          projectLabel: previewProof.projectLabel,
          title: previewProof.previewTitle,
          stackId: previewProof.stackId
        },
        previewProof.verification,
        params.runId
      );
    }

    if (!preview && params.threadId) {
      const latestPreview = this.getLatestThreadVerificationPreview(params.threadId.trim());
      if (latestPreview.lastVerification) {
        return this.toResolvedProof(latestPreview, latestPreview.lastVerification, params.runId);
      }
    }

    if (!preview) {
      throw new Error("review_preview_proof requires a preview or job selector.");
    }

    throw new Error(`Preview ${preview.id} does not have a recorded verification yet.`);
  }

  private resolveWorkspaceProject(cwd: string | null | undefined, fallbackId: string, fallbackLabel: string) {
    const project = resolveWorkspaceProjectInfo(cwd);
    if (project.id === "unknown") {
      return {
        id: fallbackId,
        label: fallbackLabel
      };
    }

    return project;
  }

  private removeStackArtifacts(stackId: string): void {
    for (const lease of this.store.listPreviewLeases()) {
      if (lease.stackId === stackId) {
        this.store.removePreviewLease(lease.id);
      }
    }

    for (const lease of this.store.listServiceLeases()) {
      if (lease.stackId === stackId) {
        this.store.removeServiceLease(lease.id);
      }
    }

    this.store.removeStackLease(stackId);
  }

  private normalizeServiceEnv(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
        .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
        .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
    );
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean))];
  }

  private describeStackStorage(stack: {
    storageMode: "ephemeral" | "job" | "base" | "custom";
    baseStorageKey: string | null;
    storageKey: string | null;
    cloneFromStorageKey: string | null;
    defaultPromoteTargetStorageKey: string | null;
    retainsVolumes: boolean;
    volumeNames: string[];
  }): string {
    return formatStackStorageSummary(stack);
  }

  private async resolveProofReviewModel(): Promise<Model<any>> {
    if (!this.modelRegistry) {
      throw new Error("Butler model registry is not ready");
    }

    const currentModel = this.session?.model;
    if (currentModel?.input.includes("image")) {
      return currentModel;
    }

    const availableModels = this.modelRegistry.getAvailable().filter((model) => model.input.includes("image"));
    const currentProvider = currentModel?.provider ?? null;
    const preferredModel =
      (currentProvider ? availableModels.find((model) => model.provider === currentProvider) : null) ??
      availableModels.find((model) => model.provider === "openai-codex" || model.provider === "openai") ??
      availableModels[0];

    if (!preferredModel) {
      throw new Error("No vision-capable Butler model is available.");
    }

    return preferredModel;
  }

  private async reviewProofScreenshot(
    proof: ResolvedPreviewProof,
    options?: {
      expectedOutcome?: string;
    }
  ): Promise<ProofScreenshotReview> {
    if (!this.modelRegistry) {
      throw new Error("Butler model registry is not ready");
    }

    const model = await this.resolveProofReviewModel();
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    const screenshotBuffer = await fs.readFile(proof.screenshot.filePath);
    const reviewPrompt = [
      "Review this Playwright screenshot as proof of frontend execution.",
      "Be strict and describe only what is visibly present in the screenshot.",
      "Return JSON only with keys verdict, visibleState, evidence, concern.",
      "Set verdict to one of: credible, unclear, failed.",
      options?.expectedOutcome?.trim() ? `Expected outcome: ${options.expectedOutcome.trim()}` : "",
      `Preview title: ${proof.preview.title}`,
      `Verification mode: ${proof.verification.mode}`,
      `Verification status: ${proof.verification.status ?? "none"}`,
      `Verification failure kind: ${proof.verification.failureKind}`,
      `Readiness route ok: ${proof.verification.readiness.routeOk}`,
      `Readiness login redirect detected: ${proof.verification.readiness.loginRedirectDetected}`
    ]
      .filter(Boolean)
      .join("\n");

    const response = await complete(
      model,
      {
        systemPrompt:
          "You are a strict UI proof reviewer. Judge only what is clearly visible. Do not assume success when the page looks blank, loading, or error-like.",
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [
              { type: "text", text: reviewPrompt },
              {
                type: "image",
                data: screenshotBuffer.toString("base64"),
                mimeType: proof.screenshot.contentType || "image/png"
              }
            ]
          }
        ]
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers
      }
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "Butler screenshot review failed.");
    }

    const rawText = contentToText(response.content).trim();
    if (!rawText) {
      throw new Error("Butler screenshot review returned no text.");
    }

    const parsed = parseProofScreenshotReview(rawText) ?? {
      verdict: "unclear",
      visibleState: "The screenshot review model returned unstructured output.",
      evidence: rawText,
      concern: "Review output needs manual interpretation.",
      rawText,
      reviewedAt: Date.now(),
      modelId: "",
      modelProvider: ""
    };

    return {
      ...parsed,
      rawText,
      reviewedAt: Date.now(),
      modelId: model.id,
      modelProvider: model.provider
    };
  }

  private buildCustomTools() {
    return [
      this.defineButlerTool({
        name: "prepare_worktree",
        label: "Prepare worktree",
        description: "Create a dedicated butler/ branch and isolated git worktree before parallel Codex work starts.",
        promptSnippet: "prepare_worktree: use this before delegating repo work so parallel jobs do not share one checkout.",
        parameters: Type.Object({
          cwd: Type.String(),
          task: Type.String({ minLength: 1 })
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "prepare_worktree")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { cwd: string; task: string };
          const workspace = await this.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
          return {
            content: [
              {
                type: "text",
                text: workspace.branchName
                  ? `Prepared worktree ${workspace.cwd} on branch ${workspace.branchName}.`
                  : `No git worktree was needed. Using ${workspace.cwd}.`
              }
            ],
            details: workspace
          };
        }
      }),
      this.defineButlerTool({
        name: "list_stacks",
        label: "List stacks",
        description: "List the active stack leases and their isolated networks.",
        promptSnippet: "list_stacks: inspect stack-backed environments before creating another multi-container runtime.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_stacks")?.uiEffects ?? [],
        execute: async () => {
          const stacks = this.store.listStackLeases();
          const text =
            stacks.length === 0
              ? "No stack leases are active."
              : stacks
                .map(
                  (stack, index) =>
                      `${index + 1}. ${stack.title} | thread=${stack.threadId ?? "(none)"} | status=${stack.status} | network=${stack.networkName} | ${this.describeStackStorage(stack)} | previews=${stack.previewIds.length} | services=${stack.serviceIds.length}`
                  )
                  .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { stacks }
          };
        }
      }),
      this.defineButlerTool({
        name: "start_stack",
        label: "Start stack",
        description: "Create one isolated stack lease and network for a multi-container job.",
        promptSnippet:
          "start_stack: use this before launching multiple cooperating previews or services for one job. Prefer storageMode=job for recurring mutable databases so each job gets its own writable fork from the project base. Use storageMode=base only when intentionally seeding or refreshing the shared base state.",
        parameters: Type.Object({
          threadId: Type.Optional(Type.String()),
          title: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String()),
          storageMode: Type.Optional(
            Type.Union([Type.Literal("ephemeral"), Type.Literal("job"), Type.Literal("base"), Type.Literal("custom")])
          ),
          retainsVolumes: Type.Optional(Type.Boolean()),
          storageKey: Type.Optional(Type.String()),
          cloneFromStorageKey: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "start_stack")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            threadId?: string;
            title: string;
            cwd?: string;
            storageMode?: "ephemeral" | "job" | "base" | "custom";
            retainsVolumes?: boolean;
            storageKey?: string;
            cloneFromStorageKey?: string;
          };
          const thread = typedParams.threadId ? this.store.getThread(typedParams.threadId) ?? null : null;
          const worktreePath = typedParams.cwd?.trim() || thread?.cwd || null;
          const project = this.resolveWorkspaceProject(
            worktreePath,
            thread?.supervisor.projectId ?? "stack",
            thread?.supervisor.projectLabel ?? "stack"
          );
          const stack = await this.runtimeBroker.createStack({
            stackId: crypto.randomUUID(),
            threadId: typedParams.threadId ?? null,
            projectId: project.id,
            projectLabel: project.label,
            title: typedParams.title.trim(),
            worktreePath,
            storageMode: normalizeStackStorageMode(typedParams.storageMode) ?? null,
            retainsVolumes: Boolean(typedParams.retainsVolumes),
            storageKey: typedParams.storageKey?.trim() || null,
            cloneFromStorageKey: typedParams.cloneFromStorageKey?.trim() || null
          });
          this.store.upsertStackLease(stack);
          return {
            content: [
              {
                type: "text",
                text: `Started stack ${stack.title}. Network=${stack.networkName}. ${this.describeStackStorage(stack)}.`
              }
            ],
            details: { stack }
          };
        }
      }),
      this.defineButlerTool({
        name: "inspect_stack",
        label: "Inspect stack",
        description: "Inspect one stack lease and return its current state.",
        promptSnippet: "inspect_stack: use this to confirm what a multi-container environment already contains before changing it.",
        parameters: Type.Object({
          stackId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "inspect_stack")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { stackId: string };
          const stack = await this.runtimeBroker.inspectStack(typedParams.stackId);
          this.store.upsertStackLease(stack);
          this.store.noteStackLeaseActivity(typedParams.stackId);
          return {
            content: [
              {
                type: "text",
                text: `${stack.title} is ${stack.status}. Network=${stack.networkName}. ${this.describeStackStorage(stack)}. Previews=${stack.previewIds.length}. Services=${stack.serviceIds.length}.`
              }
            ],
            details: { stack }
          };
        }
      }),
      this.defineButlerTool({
        name: "promote_stack",
        label: "Promote stack",
        description: "Copy a stack's retained volumes into another storage namespace.",
        promptSnippet: "promote_stack: use this when one job's retained database or object-store state should become the new shared base.",
        parameters: Type.Object({
          stackId: Type.String(),
          targetStorageKey: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "promote_stack")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { stackId: string; targetStorageKey?: string };
          const promotion = await this.runtimeBroker.promoteStack({
            stackId: typedParams.stackId,
            targetStorageKey: typedParams.targetStorageKey?.trim() || null
          });
          const stack = await this.runtimeBroker.inspectStack(typedParams.stackId);
          this.store.upsertStackLease(stack);
          this.store.noteStackLeaseActivity(typedParams.stackId);
          return {
            content: [
              {
                type: "text",
                text: `Promoted ${promotion.promotedVolumes.length} volumes from ${promotion.sourceStorageKey} to ${promotion.targetStorageKey}.`
              }
            ],
            details: { promotion, stack }
          };
        }
      }),
      this.defineButlerTool({
        name: "stop_stack",
        label: "Stop stack",
        description: "Stop one stack lease, remove its members, and release its network.",
        promptSnippet: "stop_stack: use this to tear down a whole multi-container environment once the job is done.",
        parameters: Type.Object({
          stackId: Type.String(),
          dropVolumes: Type.Optional(Type.Boolean())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "stop_stack")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { stackId: string; dropVolumes?: boolean };
          await this.runtimeBroker.stopStack(typedParams.stackId, { dropVolumes: Boolean(typedParams.dropVolumes) });
          this.removeStackArtifacts(typedParams.stackId);
          return {
            content: [
              {
                type: "text",
                text: `Stopped stack ${typedParams.stackId}.${typedParams.dropVolumes ? " Dropped retained volumes." : ""}`
              }
            ],
            details: { stackId: typedParams.stackId, dropVolumes: Boolean(typedParams.dropVolumes) }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_previews",
        label: "List previews",
        description: "List the active preview leases and their operator-facing URLs.",
        promptSnippet: "list_previews: inspect live preview routes before asking where to review a running app.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_previews")?.uiEffects ?? [],
        execute: async () => {
          const syncError = await this.refreshRuntimeInventoryIfAvailable();
          const leases = this.store.listPreviewLeases();
          const summary =
            leases.length === 0
              ? "No preview leases are active."
              : leases
                  .map(
                    (lease, index) =>
                      `${index + 1}. ${lease.title} | thread=${lease.threadId ?? "(none)"} | status=${lease.status}/${lease.bootstrap.phase} | route=${lease.operatorUrl}`
                  )
                  .join("\n");
          const text = syncError ? `Live runtime sync failed; showing cached state. ${syncError}\n${summary}` : summary;
          return {
            content: [{ type: "text", text }],
            details: { previews: leases, syncError }
          };
        }
      }),
      this.defineButlerTool({
        name: "start_preview",
        label: "Start preview",
        description: "Start a disposable preview runtime on the internal Manor network and expose it through a stable route.",
        promptSnippet: "start_preview: use this when a job needs a live reviewable app preview instead of a raw host port.",
        parameters: Type.Object({
          threadId: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          title: Type.String({ minLength: 1 }),
          command: Type.String({ minLength: 1 }),
          port: Type.Number({ minimum: 1, maximum: 65535 }),
          stackId: Type.Optional(Type.String()),
          aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          env: Type.Optional(Type.Record(Type.String(), Type.String())),
          image: Type.Optional(Type.String()),
          egressProfile: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Defaults to direct internet access. Use 'none' to block outbound traffic or a named preview egress profile such as 'web' to restrict it."
            })
          ),
          egressDomains: Type.Optional(
            Type.Array(
              Type.String({
                minLength: 1,
                description: "Explicit domain allowlist for this preview only, such as api.openrouter.ai or .cloudflare.com."
              })
            )
          ),
          bootstrapWaitSeconds: Type.Optional(
            Type.Number({
              minimum: 1,
              description: "How long the preview may spend bootstrapping before the heartbeat is treated as failed."
            })
          ),
          bootstrapHint: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Short hint like 'installing deps' or 'running migrations'."
            })
          ),
          heartbeatKind: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Heartbeat type: none, http, tcp, or command. Defaults to http for previews."
            })
          ),
          heartbeatTarget: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Heartbeat target such as /health, 127.0.0.1:3000, or a shell command. Defaults to / when the heartbeat kind is omitted."
            })
          ),
          heartbeatIntervalSeconds: Type.Optional(
            Type.Number({
              minimum: 1,
              description: "How often Manor should retry the heartbeat during bootstrap."
            })
          )
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "start_preview")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            threadId?: string;
            cwd: string;
            title: string;
            command: string;
            port: number;
            stackId?: string;
            aliases?: string[];
            env?: Record<string, string>;
            image?: string;
            egressProfile?: string;
            egressDomains?: string[];
            bootstrapWaitSeconds?: number;
            bootstrapHint?: string;
            heartbeatKind?: string;
            heartbeatTarget?: string;
            heartbeatIntervalSeconds?: number;
          };

          const thread = typedParams.threadId ? this.store.getThread(typedParams.threadId) ?? null : null;
          const stack = this.getValidatedStack(typedParams.stackId?.trim() || null, typedParams.threadId ?? null);
          const leaseId = crypto.randomUUID();
          const worktreePath = typedParams.cwd?.trim() || stack?.worktreePath || thread?.cwd || "";
          const project = this.resolveWorkspaceProject(
            worktreePath,
            thread?.supervisor.projectId ?? "preview",
            thread?.supervisor.projectLabel ?? "preview"
          );

          if (!worktreePath) {
            throw new Error("start_preview requires a cwd or a stack with a worktree path");
          }

          const workspaceBootstrap = await inspectWorkspaceBootstrap(worktreePath);
          const previewDefaults = applyWorkspacePreviewDefaults(
            {
              image: typedParams.image,
              egressProfile: typedParams.egressProfile ?? "internet",
              egressDomains: typedParams.egressDomains,
              bootstrapHint: typedParams.bootstrapHint
            },
            workspaceBootstrap
          );

          const lease = await this.runtimeBroker.createLease({
            leaseId,
            threadId: typedParams.threadId ?? null,
            projectId: project.id,
            projectLabel: project.label,
            title: typedParams.title,
            stackId: stack?.id ?? null,
            aliases: this.normalizeStringArray(typedParams.aliases),
            worktreePath,
            branchName: thread?.cwd === typedParams.cwd ? null : null,
            targetPort: typedParams.port,
            command: typedParams.command,
            image: previewDefaults.image,
            egressProfile: previewDefaults.egressProfile ?? "internet",
            egressDomains: previewDefaults.egressDomains ?? [],
            bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
            bootstrapHint: previewDefaults.bootstrapHint,
            heartbeatKind: typedParams.heartbeatKind as "none" | "http" | "tcp" | "command" | undefined,
            heartbeatTarget: typedParams.heartbeatTarget,
            heartbeatIntervalSeconds: typedParams.heartbeatIntervalSeconds,
            env: this.normalizeServiceEnv(typedParams.env)
          });
          this.store.upsertPreviewLease(lease);

          return {
            content: [
              {
                type: "text",
                text: `Started preview ${lease.title} at ${lease.operatorUrl}. Bootstrap=${lease.bootstrap.phase}${lease.bootstrap.hint ? ` (${lease.bootstrap.hint})` : ""}.${previewDefaults.autofilled.length > 0 ? ` Auto-filled ${previewDefaults.autofilled.join(", ")} from workspace bootstrap.` : ""}`
              }
            ],
            details: { lease, workspaceBootstrap, previewDefaults }
          };
        }
      }),
      this.defineButlerTool({
        name: "stop_preview",
        label: "Stop preview",
        description: "Stop a preview runtime and release its lease.",
        promptSnippet: "stop_preview: use this when preview work is done or a stale preview should be cleaned up.",
        parameters: Type.Object({
          leaseId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "stop_preview")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { leaseId: string };
          this.store.markPreviewLeaseStopping(typedParams.leaseId);
          await this.runtimeBroker.stopLease(typedParams.leaseId);
          this.store.removePreviewLease(typedParams.leaseId);
          return {
            content: [{ type: "text", text: `Stopped preview ${typedParams.leaseId}.` }],
            details: { leaseId: typedParams.leaseId }
          };
        }
      }),
      this.defineButlerTool({
        name: "inspect_preview",
        label: "Inspect preview",
        description: "Inspect one preview isolate and summarize its current runtime state.",
        promptSnippet: "inspect_preview: use this before diagnosing a preview so you know whether it is running, what route it has, and what egress policy it carries.",
        parameters: Type.Object({
          leaseId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "inspect_preview")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { leaseId: string };
          const lease = await this.runtimeBroker.inspectLease(typedParams.leaseId);
          this.store.upsertPreviewLease(lease);
          this.store.notePreviewLeaseActivity(typedParams.leaseId);
          const domains = lease.egressDomains.length > 0 ? lease.egressDomains.join(", ") : "(none)";
          return {
            content: [
              {
                type: "text",
                text: `${lease.title} is ${lease.runtime.status}. Bootstrap=${lease.bootstrap.phase}. Route=${lease.operatorUrl}. Egress=${lease.egressProfile}. Domains=${domains}.`
              }
            ],
            details: { lease }
          };
        }
      }),
      this.defineButlerTool({
        name: "verify_preview",
        label: "Verify preview",
        description: "Run Playwright verification for one preview and persist screenshot, video, trace, and manifest artifacts.",
        promptSnippet:
          "verify_preview: use this to produce proof artifacts for a preview. Use headful mode when the operator wants frontend proof with video.",
        parameters: Type.Object({
          leaseId: Type.String(),
          mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("headful")])),
          path: Type.Optional(Type.String()),
          script: Type.Optional(Type.String()),
          waitForSelector: Type.Optional(Type.String()),
          postLoadWaitMs: Type.Optional(Type.Number({ minimum: 0 })),
          headers: Type.Optional(Type.Record(Type.String(), Type.String())),
          cookies: Type.Optional(Type.Record(Type.String(), Type.String())),
          sessionCookie: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "verify_preview")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            leaseId: string;
            mode?: "headless" | "headful";
            path?: string;
            script?: string;
            waitForSelector?: string;
            postLoadWaitMs?: number;
            headers?: Record<string, string>;
            cookies?: Record<string, string>;
            sessionCookie?: string;
          };
          const preview = this.requireValidatedPreview(typedParams.leaseId, null);
          const cookieEntries = Object.entries(typedParams.cookies ?? {})
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            .map(([name, value]) => [name.trim(), value.trim()] as const)
            .filter(([name, value]) => name.length > 0 && value.length > 0);
          const sessionCookie = typeof typedParams.sessionCookie === "string" ? typedParams.sessionCookie.trim() : "";
          if (sessionCookie) {
            cookieEntries.push(["better-auth.session_token", sessionCookie]);
          }
          const verification = decoratePreviewVerification(
            await this.runtimeBroker.verifyLease({
              leaseId: preview.id,
              mode: typedParams.mode === "headful" ? "headful" : "headless",
              path: typedParams.path?.trim() || undefined,
              script: typedParams.script?.trim() || undefined,
              waitForSelector: typedParams.waitForSelector?.trim() || undefined,
              postLoadWaitMs:
                typeof typedParams.postLoadWaitMs === "number" && Number.isFinite(typedParams.postLoadWaitMs)
                  ? Math.max(0, Math.trunc(typedParams.postLoadWaitMs))
                  : undefined,
              headers:
                typedParams.headers && Object.keys(typedParams.headers).length > 0 ? typedParams.headers : undefined,
              cookies: cookieEntries.length > 0 ? cookieEntries.map(([name, value]) => ({ name, value })) : undefined
            })
          );
          this.store.recordPreviewLeaseVerification(preview.id, verification);
          this.store.notePreviewLeaseActivity(preview.id);

          const screenshot = findVerificationArtifact(verification, "screenshot");
          const video = findVerificationArtifact(verification, "video");
          const proofNotes = [
            screenshot?.url ? "screenshot ready" : "screenshot missing",
            video?.downloadUrl ? "video ready" : "video missing"
          ].join(", ");

          return {
            content: [
              {
                type: "text",
                text: verification.ok
                  ? `Verified ${preview.title} in ${verification.mode} mode. ${proofNotes}.`
                  : `Verification failed for ${preview.title} in ${verification.mode} mode. Failure=${verification.failureKind}.${verification.status ? ` Status=${verification.status}.` : ""}`
              }
            ],
            details: {
              preview,
              verification,
              screenshot,
              video
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "review_preview_proof",
        label: "Review preview proof",
        description: "Inspect the latest screenshot proof for one preview or job and surface the video download for human review.",
        promptSnippet:
          "review_preview_proof: use this when frontend execution proof is demanded. Do not sign off until the screenshot has been reviewed and the video bundle is surfaced for human review.",
        parameters: Type.Object({
          leaseId: Type.Optional(Type.String()),
          threadId: Type.Optional(Type.String()),
          runId: Type.Optional(Type.String()),
          expectedOutcome: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "review_preview_proof")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            leaseId?: string;
            threadId?: string;
            runId?: string;
            expectedOutcome?: string;
          };

          const proof = this.resolvePreviewProof({
            leaseId: typedParams.leaseId?.trim(),
            threadId: typedParams.threadId?.trim(),
            runId: typedParams.runId?.trim()
          });
          const review = await this.reviewProofScreenshot(proof, {
            expectedOutcome: typedParams.expectedOutcome
          });

          const videoRequirementMet = Boolean(proof.video?.downloadUrl);
          const proofVerdict = videoRequirementMet ? review.verdict : "incomplete";
          const proofSummary = [
            `Verdict=${proofVerdict}`,
            `FailureKind=${proof.verification.failureKind}`,
            `Visible=${review.visibleState}`,
            `Evidence=${review.evidence}`,
            `Concern=${videoRequirementMet ? review.concern : "Video proof is missing for human review."}`
          ].join("\n");

          return {
            content: [
              {
                type: "text",
                text: [
                  `Reviewed proof for ${proof.preview.title}.`,
                  proofSummary,
                  proof.video?.downloadUrl ? `Video download: ${proof.video.downloadUrl}` : "Video download: unavailable",
                  proof.screenshot.url ? `Screenshot: ${proof.screenshot.url}` : "Screenshot: unavailable"
                ].join("\n")
              }
            ],
            details: {
              preview: proof.preview,
              verification: proof.verification,
              screenshot: proof.screenshot,
              video: proof.video,
              manifest: proof.manifest,
              trace: proof.trace,
              review,
              proofComplete: videoRequirementMet
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "preview_processes",
        label: "Preview processes",
        description: "List processes running inside one preview isolate.",
        promptSnippet: "preview_processes: use this when a preview seems stuck and you need to see the running process table.",
        parameters: Type.Object({
          leaseId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "preview_processes")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { leaseId: string };
          const result = await this.runtimeBroker.listProcesses(typedParams.leaseId);
          this.store.notePreviewLeaseActivity(typedParams.leaseId);
          const rows = result.processes.length === 0
            ? "No processes were reported."
            : [result.titles.join(" | "), ...result.processes.map((row) => row.join(" | "))].join("\n");
          return {
            content: [{ type: "text", text: rows }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "preview_logs",
        label: "Preview logs",
        description: "Read recent logs from one preview isolate.",
        promptSnippet: "preview_logs: use this when a preview boot or app route is failing and you need the recent container output.",
        parameters: Type.Object({
          leaseId: Type.String(),
          tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "preview_logs")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { leaseId: string; tail?: number };
          const result = await this.runtimeBroker.readLogs(typedParams.leaseId, typedParams.tail ?? 200);
          this.store.notePreviewLeaseActivity(typedParams.leaseId);
          return {
            content: [{ type: "text", text: result.logs || "No logs were returned." }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "exec_preview",
        label: "Exec in preview",
        description: "Run one shell command inside a preview isolate through the runtime broker.",
        promptSnippet: "exec_preview: use this when Butler needs to inspect or patch a preview isolate directly without opening the shared terminal.",
        parameters: Type.Object({
          leaseId: Type.String(),
          command: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "exec_preview")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { leaseId: string; command: string; cwd?: string };
          const result = await this.runtimeBroker.execInLease(typedParams);
          this.store.notePreviewLeaseActivity(typedParams.leaseId);
          const stdout = result.stdout.trim();
          const stderr = result.stderr.trim();
          const body =
            [`exit=${result.exitCode ?? "unknown"}`]
              .concat(stdout ? [`stdout:\n${stdout}`] : [])
              .concat(stderr ? [`stderr:\n${stderr}`] : [])
              .join("\n\n") || `exit=${result.exitCode ?? "unknown"}`;
          return {
            content: [{ type: "text", text: body }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "list_service_templates",
        label: "List service templates",
        description: "List the built-in Manor service templates Butler can provision.",
        promptSnippet: "list_service_templates: use this before provisioning local dependencies so you reuse the built-in Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite templates.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_service_templates")?.uiEffects ?? [],
        execute: async () => {
          const text = this.serviceTemplates
            .map(
              (template, index) =>
                `${index + 1}. ${template.id} | ${template.label} | runtime=${template.runtimeKind} | engine=${template.engine} | port=${template.defaultPort} | ${template.description}`
            )
            .join("\n");
          return {
            content: [{ type: "text", text: text || "No service templates are available." }],
            details: { serviceTemplates: this.serviceTemplates }
          };
        }
      }),
      this.defineButlerTool({
        name: "start_service",
        label: "Start service",
        description: "Provision a built-in service for one job, with stack-backed persistence when the stack retains volumes.",
        promptSnippet: "start_service: use this when an app needs a local dependency like Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite.",
        parameters: Type.Object({
          templateId: Type.String({ minLength: 1 }),
          title: Type.Optional(Type.String()),
          threadId: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          stackId: Type.Optional(Type.String()),
          aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          env: Type.Optional(Type.Record(Type.String(), Type.String()))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "start_service")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            templateId: string;
            title?: string;
            threadId?: string;
            cwd?: string;
            stackId?: string;
            aliases?: string[];
            env?: Record<string, string>;
          };
          const template = this.getServiceTemplate(typedParams.templateId);
          const thread = typedParams.threadId ? this.store.getThread(typedParams.threadId) ?? null : null;
          const stack = this.getValidatedStack(typedParams.stackId?.trim() || null, typedParams.threadId ?? null);
          const mergedEnv = {
            ...template.envDefaults,
            ...this.normalizeServiceEnv(typedParams.env)
          };
          const serviceId = crypto.randomUUID();
          const effectiveTitle = typedParams.title?.trim() || `${template.label} ${serviceId.slice(0, 8)}`;
          const worktreePath = typedParams.cwd?.trim() || stack?.worktreePath || thread?.cwd || "/repos";
          const project = this.resolveWorkspaceProject(
            worktreePath,
            thread?.supervisor.projectId ?? "service",
            thread?.supervisor.projectLabel ?? "service"
          );

          if (template.runtimeKind === "embedded") {
            const filePath = `${worktreePath}/${template.fileName ?? ".manor/sqlite/app.db"}`.replace(/\/+/g, "/");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            const handle = await fs.open(filePath, "a");
            await handle.close();
            const lease = toServiceLeaseView({
              id: serviceId,
              threadId: typedParams.threadId ?? null,
              projectId: project.id,
              projectLabel: project.label,
              title: effectiveTitle,
              stackId: stack?.id ?? null,
              aliases: this.normalizeStringArray(typedParams.aliases),
              template,
              containerName: `embedded-${serviceId}`,
              targetHost: "local-file",
              targetPort: 0,
              worktreePath: filePath,
              status: "running",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastError: null,
              env: mergedEnv
            });
            this.store.upsertServiceLease(lease);
            return {
              content: [{ type: "text", text: `Provisioned ${template.label}. ${lease.connection.uri ?? filePath}` }],
              details: { service: lease }
            };
          }

          const service = await this.runtimeBroker.createService({
            serviceId,
            threadId: typedParams.threadId ?? null,
            projectId: project.id,
            projectLabel: project.label,
            title: effectiveTitle,
            stackId: stack?.id ?? null,
            aliases: this.normalizeStringArray(typedParams.aliases),
            templateId: template.id,
            templateLabel: template.label,
            runtimeKind: template.runtimeKind,
            worktreePath,
            targetPort: template.defaultPort,
            image: template.image,
            command: template.command,
            stackVolumePath: template.stackVolumePath,
            env: mergedEnv
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
          return {
            content: [
              {
                type: "text",
                text: `Started ${template.label}. Host=${lease.connection.host} Port=${lease.connection.port}.${lease.sticky ? ` Sticky volume=${lease.volumeName}.` : ""}`
              }
            ],
            details: { service: lease }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_services",
        label: "List services",
        description: "List active disposable services and their connection details.",
        promptSnippet: "list_services: inspect local dependencies already provisioned for the current work.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_services")?.uiEffects ?? [],
        execute: async () => {
          const syncError = await this.refreshRuntimeInventoryIfAvailable();
          const services = this.store.listServiceLeases();
          const summary =
            services.length === 0
              ? "No disposable services are active."
              : services
                  .map(
                    (service, index) =>
                      `${index + 1}. ${service.title} | template=${service.templateId} | status=${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | host=${service.connection.host} | port=${service.connection.port} | uri=${service.connection.uri ?? "(none)"}`
                  )
                  .join("\n");
          const text = syncError ? `Live runtime sync failed; showing cached state. ${syncError}\n${summary}` : summary;
          return {
            content: [{ type: "text", text }],
            details: { services, syncError }
          };
        }
      }),
      this.defineButlerTool({
        name: "inspect_service",
        label: "Inspect service",
        description: "Inspect one service runtime and return its current state.",
        promptSnippet: "inspect_service: use this before debugging a dependency so you know whether it is running and how to reach it.",
        parameters: Type.Object({
          serviceId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "inspect_service")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { serviceId: string };
          const existing = this.requireValidatedService(typedParams.serviceId, null);
          if (existing.runtimeKind === "embedded") {
            this.store.noteServiceLeaseActivity(existing.id);
            return {
              content: [{ type: "text", text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.` }],
              details: { service: existing }
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
            content: [
              {
                type: "text",
                text: `${lease.title} is ${inspected.runtime.status}. Host=${lease.connection.host} Port=${lease.connection.port}. Storage=${lease.storageKind}${lease.volumeName ? `(${lease.volumeName})` : ""}.`
              }
            ],
            details: { service: lease, runtime: inspected.runtime }
          };
        }
      }),
      this.defineButlerTool({
        name: "service_logs",
        label: "Service logs",
        description: "Read recent logs from one container-backed service runtime.",
        promptSnippet: "service_logs: use this when a dependency boot or health check is failing and you need recent container output.",
        parameters: Type.Object({
          serviceId: Type.String(),
          tail: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 }))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "service_logs")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { serviceId: string; tail?: number };
          const service = this.requireValidatedService(typedParams.serviceId, null);
          if (service.runtimeKind !== "container") {
            this.store.noteServiceLeaseActivity(service.id);
            return {
              content: [{ type: "text", text: `${service.title} is embedded and does not expose container logs.` }],
              details: { service }
            };
          }
          const result = await this.runtimeBroker.readServiceLogs(service.id, typedParams.tail ?? 200);
          this.store.noteServiceLeaseActivity(service.id);
          return {
            content: [{ type: "text", text: result.logs || "No logs were returned." }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "exec_service",
        label: "Exec in service",
        description: "Run one shell command inside a container-backed service runtime.",
        promptSnippet: "exec_service: use this when Butler needs to inspect or patch a service directly.",
        parameters: Type.Object({
          serviceId: Type.String(),
          command: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "exec_service")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { serviceId: string; command: string; cwd?: string };
          const service = this.requireValidatedService(typedParams.serviceId, null);
          if (service.runtimeKind !== "container") {
            this.store.noteServiceLeaseActivity(service.id);
            return {
              content: [{ type: "text", text: `${service.title} is embedded and does not support container exec.` }],
              details: { service }
            };
          }
          const result = await this.runtimeBroker.execInService({
            serviceId: service.id,
            command: typedParams.command,
            cwd: typedParams.cwd
          });
          this.store.noteServiceLeaseActivity(service.id);
          const stdout = result.stdout.trim();
          const stderr = result.stderr.trim();
          const body =
            [`exit=${result.exitCode ?? "unknown"}`]
              .concat(stdout ? [`stdout:\n${stdout}`] : [])
              .concat(stderr ? [`stderr:\n${stderr}`] : [])
              .join("\n\n") || `exit=${result.exitCode ?? "unknown"}`;
          return {
            content: [{ type: "text", text: body }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "stop_service",
        label: "Stop service",
        description: "Stop one disposable service runtime and release its lease.",
        promptSnippet: "stop_service: use this when a disposable service is no longer needed.",
        parameters: Type.Object({
          serviceId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "stop_service")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { serviceId: string };
          const service = this.requireValidatedService(typedParams.serviceId, null);
          if (service.runtimeKind === "container") {
            await this.runtimeBroker.stopService(service.id);
          }
          this.store.removeServiceLease(service.id);
          return {
            content: [{ type: "text", text: `Stopped ${service.title}.` }],
            details: { serviceId: service.id }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_jobs",
        label: "List jobs",
        description: "List Codex jobs, their statuses, and short previews.",
        promptSnippet: "list_jobs: inspect the current Codex jobs by status and recency.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
          status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("idle"), Type.Literal("unknown")]))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_jobs")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { limit?: number; status?: "active" | "idle" | "unknown" };
          const limit = typedParams.limit ?? 10;
          return {
            content: [{ type: "text", text: buildJobsSummary(this.store, limit, typedParams.status) }],
            details: {
              jobs: this.store.listThreads().slice(0, limit)
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "read_job",
        label: "Read job",
        description: "Read a Codex job in detail, including loaded turns and messages.",
        promptSnippet: "read_job: inspect one specific Codex job in detail.",
        parameters: Type.Object({
          threadId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "read_job")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string };
          await this.codexClient.loadThread(typedParams.threadId);
          const thread = this.store.getThread(typedParams.threadId) ?? null;
          const workspaceBootstrap = await inspectWorkspaceBootstrap(thread?.cwd);
          return {
            content: [
              {
                type: "text",
                text: [buildJobDetail(this.store, typedParams.threadId), ...formatWorkspaceBootstrapLines(workspaceBootstrap)].join("\n")
              }
            ],
            details: {
              thread,
              workspaceBootstrap
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "inspect_workspace_bootstrap",
        label: "Inspect workspace bootstrap",
        description: "Inspect the current workspace for runtime bootstrap hints such as package manager, install state, and preview egress defaults.",
        promptSnippet: "inspect_workspace_bootstrap: use this before creating a preview when project setup or dependency bootstrap is unclear.",
        parameters: Type.Object({
          cwd: Type.Optional(Type.String()),
          threadId: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "inspect_workspace_bootstrap")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { cwd?: string; threadId?: string };
          const thread = typedParams.threadId ? this.store.getThread(typedParams.threadId) ?? null : null;
          const cwd = typedParams.cwd?.trim() || thread?.cwd || "";
          if (!cwd) {
            throw new Error("inspect_workspace_bootstrap requires a cwd or threadId");
          }
          const workspaceBootstrap = await inspectWorkspaceBootstrap(cwd);
          return {
            content: [{ type: "text", text: formatWorkspaceBootstrapLines(workspaceBootstrap).join("\n") }],
            details: {
              cwd,
              thread,
              workspaceBootstrap
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_projects",
        label: "List projects",
        description: "List repo-level Codex supervision summaries so Butler can stay on top of many threads.",
        promptSnippet: "list_projects: inspect repo-level summaries before drilling into individual jobs.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 }))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_projects")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { limit?: number };
          const limit = typedParams.limit ?? 10;
          return {
            content: [{ type: "text", text: buildProjectsSummary(this.store, limit) }],
            details: {
              projects: this.store.listProjectSummaries().slice(0, limit)
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "read_project",
        label: "Read project",
        description: "Read the current summary for one project and its tracked Codex threads.",
        promptSnippet: "read_project: inspect one tracked project and its active Codex threads.",
        parameters: Type.Object({
          projectId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "read_project")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { projectId: string };
          return {
            content: [{ type: "text", text: buildProjectDetail(this.store, typedParams.projectId) }],
            details: {
              project: this.store.getProjectSummary(typedParams.projectId) ?? null
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "supervisor_overview",
        label: "Supervisor overview",
        description: "Return the top-level supervisor summary across all tracked Codex projects and threads.",
        promptSnippet: "supervisor_overview: get the current top-level state before planning or answering status questions.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "supervisor_overview")?.uiEffects ?? [],
        execute: async () => {
          return {
            content: [{ type: "text", text: buildSupervisorOverview(this.store) }],
            details: {
              supervisor: this.store.getSupervisorSummary(),
              projects: this.store.listProjectSummaries()
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_image_references",
        label: "List image references",
        description: "List the stored operator-provided image references Butler can reuse for delegation or verification.",
        promptSnippet: "list_image_references: inspect stored reference images before delegating visual work or checking a finished UI.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 }))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_image_references")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { limit?: number };
          const references = this.imageStore.list(typedParams.limit ?? 10);
          const text =
            references.length === 0
              ? "No stored image references are available yet."
              : references
                  .map(
                    (reference, index) =>
                      `${index + 1}. ${reference.id} | ${reference.name} | ${new Date(reference.createdAt).toISOString()}`
                  )
                  .join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              imageReferences: references
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "delegate_to_codex",
        label: "Delegate to Codex",
        description: "Start a new Codex workstream for an execution task such as repo cloning, project setup, coding work, or command execution.",
        promptSnippet: "delegate_to_codex: use this when the operator wants Butler to actually make Codex do work instead of just answering with instructions.",
        parameters: Type.Object({
          task: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String()),
          goal: Type.Optional(Type.String()),
          imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "delegate_to_codex")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { task: string; cwd?: string; goal?: string; imageReferenceIds?: string[] };
          const workspace = await this.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
          const developerInstructions = [
            "This thread was started by Butler.",
            "You are the worker inside Manor. Butler is the supervisor and policy owner.",
            "Execute the requested task directly instead of explaining how the operator could do it manually.",
            "The task prompt includes an AUTHORITATIVE JOB CONTRACT with the assigned thread id, workspace, and harness binding. Follow that contract over any stale worktree or cwd hints elsewhere in the task.",
            "Treat the contract execution_mode as binding. Do not switch from local Manor branch runtime to a live deployed site unless the operator explicitly asked for live verification.",
            `Work inside ${workspace.cwd} unless the task explicitly requires a deeper subdirectory.`,
            workspace.branchName
              ? `Stay on branch ${workspace.branchName}. Do not switch back to main or share this branch with another task.`
              : "When the task touches git in a repository, create or reuse a dedicated branch whose name starts with butler/.",
            "If this job needs a preview isolate, a disposable service, or runtime inspection, use `manor-harness` with the thread binding from the contract.",
            "Start with `manor-harness --thread <jobId> status` to see what Manor already attached to this job and to inspect workspace bootstrap hints.",
            "Use the universal Manor runtime model: Butler owns policy, the broker owns lifecycle, and a preview is your plain dev box.",
            "Keep the flow simple: start a preview, then use `manor-harness preview exec`, `logs`, `processes`, `inspect`, and `verify` to adapt the project.",
            "Do not wait for Manor to infer project-specific bootstrap details. If the app needs an install command, env setup, or a custom start command, run those explicitly inside the preview.",
            "If the work needs multiple cooperating services, create a stack first with `manor-harness stack start`, then attach previews and services to it with `--stack <stackId>` and stable `--alias` names that mirror the app's expected internal hostnames.",
            "When a stack needs recurring databases or object storage, start it with `manor-harness stack start --stateful` so Manor derives a per-job retained storage key, forks from the project base, and sets the default promotion target automatically.",
            "Use `--storage-mode base` only when you are intentionally creating or refreshing the shared base state for that project. Do not share one writable database volume across concurrent jobs.",
            "After validating a job-scoped stateful stack, use `manor-harness stack promote <stackId>` to publish its retained data back to the project base. Only override the target manually when the task explicitly needs a different namespace.",
            "For attached previews and services, use `manor-harness` for inspect, logs, processes, and exec directly against the runtime. Butler still owns start, stop, lifecycle, and policy.",
            "The shared Codex shell egress is intentionally narrow and will block package-manager bootstrap for many repos. Treat those failures as shared-shell friction, not as proof that Manor preview execution is blocked.",
            "If package-manager bootstrap, dependency install, or dev startup is needed, prefer a preview and let Manor auto-fill scoped preview defaults from the workspace before declaring the job blocked.",
            "Once a preview is up, treat it as your primary dev box for that job. Install dependencies there, run long-lived app processes there, inspect logs/processes there, and use it to verify fixes.",
            "Prefer explicit, boring commands over wrappers or project-specific Manor tricks. The goal is stable runtime control, not clever bootstrap.",
            "Preview commands start with the job worktree as the working directory. Prefer relative paths there, or use the contract cwd under /repos. Do not assume a /workspace mount exists inside previews.",
            "If local shell bootstrap fails or you need supervisory guidance, use `manor-harness assist --summary \"<what is stuck>\" --details \"<error and context>\"` before your final blocked report.",
            "When frontend proof is required, run `manor-harness preview verify <preview> --mode headful --json` so the screenshot, video, trace, and manifest bundle is persisted.",
            "When proof requires actual UI interaction, pass a browser script with `manor-harness preview verify <preview> --script-file <path> --mode headful --json` instead of stopping at a static page.",
            "When the proof route needs an authenticated session, prefer `manor-harness preview verify <preview> --session-cookie <token> ...` or `--cookie NAME=VALUE ...` instead of building wrapper scripts that call `page.goto()` again.",
            "If the contract is for local Manor branch runtime and the app has email flows, prefer Mailpit or another built-in local dependency when the app under test is running inside Manor.",
            "After verification, inspect the proof bundle with `manor-harness preview proof <preview> --json` and include the screenshot, video, and manifest links in your report.",
            "Do not treat artifact existence alone as accepted proof. Butler must review the screenshot, and the video is for human review.",
            "Use only the harness actions exposed through `manor-harness`. Do not try to command Butler directly outside those actions.",
            "When you complete meaningful work, record a supervisor report before your final reply with `manor-harness report --status completed --summary \"<concise outcome>\" --details \"<brief oversight note with the key fact, risk, or next step>\"`.",
            "If you are blocked or need operator attention, record it before your reply with `manor-harness report --status blocked --summary \"<what is blocked>\" --details \"<what you need, what failed, or the next recommended action>\"`.",
            "Do not report runtime verification blocked while a preview path remains untried unless you explain why preview execution itself is blocked.",
            "Supervisor reports should help Butler oversee the job. Keep `summary` short and outcome-first, and use `details` for the extra context Butler should surface without dumping the whole conversation.",
            "Keep the thread focused on the delegated task and report concise progress and outcome."
          ].join("\n");

          const result = await this.codexClient.startThread({
            task: typedParams.goal ? `${typedParams.task}\n\nGoal: ${typedParams.goal}` : typedParams.task,
            input: async (threadId: string) =>
              this.imageStore.buildCodexInput(
                (
                  await this.buildDelegationContract({
                    threadId,
                    task: typedParams.task,
                    goal: typedParams.goal,
                    workspace
                  })
                ).text,
                typedParams.imageReferenceIds ?? []
              ),
            cwd: workspace.cwd,
            developerInstructions,
            openWindow: true
          });
          const delegationContract = await this.buildDelegationContract({
            threadId: result.threadId,
            task: typedParams.task,
            goal: typedParams.goal,
            workspace
          });
          this.store.setThreadExecutionContract(result.threadId, delegationContract.contract);
          const supervision = this.store.noteButlerSteer(result.threadId);

          return {
            content: [
              {
                type: "text",
                text: `Delegated the task to Codex in job ${result.threadId} from ${workspace.cwd}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
              }
            ],
            details: {
              threadId: result.threadId,
              supervision,
              workspace,
              thread: this.store.getThread(result.threadId) ?? null
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "open_job_window",
        label: "Open job window",
        description: "Open a focused job window in the Butler UI for a specific Codex job.",
        promptSnippet: "open_job_window: open a deeper UI window for a job the operator wants to inspect.",
        parameters: Type.Object({
          threadId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "open_job_window")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string };
          await this.codexClient.loadThread(typedParams.threadId);
          this.store.openWindow(typedParams.threadId);
          return {
            content: [{ type: "text", text: `Opened a window for job ${typedParams.threadId}.` }],
            details: {
              thread: this.store.getThread(typedParams.threadId) ?? null
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "list_open_windows",
        label: "List open windows",
        description: "List the windows currently open in the Butler UI.",
        promptSnippet: "list_open_windows: see which job windows are already open.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "list_open_windows")?.uiEffects ?? [],
        execute: async () => {
          const snapshot = this.store.getSnapshot(this.getSnapshot(), this.codexClient.getConnectionState());

          const text =
            snapshot.codex.windows.length === 0
              ? "No windows are open."
              : snapshot.codex.windows.map((window, index) => `${index + 1}. ${window.threadId} | ${window.title}`).join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              windows: snapshot.codex.windows
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "message_job",
        label: "Message job",
        description: "Privately send a follow-up into one Codex job thread when the execution mode and strategy are still the same.",
        promptSnippet: "message_job: steer a Codex job privately only when the task stays on the same execution mode and runtime strategy.",
        parameters: Type.Object({
          threadId: Type.String(),
          text: Type.String({ minLength: 1 }),
          imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "message_job")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string; text: string; imageReferenceIds?: string[] };
          const thread = this.store.getThread(typedParams.threadId);
          if (!thread || !thread.cwd || thread.source === "unknown" || thread.turnCount === 0) {
            throw new Error(
              `Job ${typedParams.threadId} is not a valid reusable Codex workstream. Start a fresh Codex job with delegate_to_codex instead.`
            );
          }
          const requestedMode = detectExecutionMode(typedParams.text);
          const currentMode =
            thread.executionContract?.executionMode ??
            detectExecutionMode([thread?.supervisor.latestUserPrompt, thread?.supervisor.latestAgentReply].filter(Boolean).join("\n"));
          if (
            thread &&
            requestedMode !== "unspecified" &&
            currentMode !== "unspecified" &&
            requestedMode !== currentMode
          ) {
            throw new Error(
              `This follow-up changes execution mode from ${describeExecutionMode(currentMode)} to ${describeExecutionMode(requestedMode)}. Start a fresh Codex job with delegate_to_codex instead of reusing this thread.`
            );
          }
          const limitMessage = this.getThreadBudgetLimitMessage(typedParams.threadId);
          if (limitMessage) {
            return {
              content: [{ type: "text", text: limitMessage }],
              details: {
                thread: thread ?? null,
                supervision: this.store.getThreadSupervision(typedParams.threadId)
              }
            };
          }
          await this.codexClient.loadThread(typedParams.threadId);
          await this.codexClient.sendMessage(
            typedParams.threadId,
            this.imageStore.buildCodexInput(typedParams.text, typedParams.imageReferenceIds ?? [])
          );
          const supervision = this.store.noteButlerSteer(typedParams.threadId);
          return {
            content: [
              {
                type: "text",
                text: `Sent a private follow-up to job ${typedParams.threadId}. Butler budget: ${supervision.butlerTurnsUsed}/${supervision.maxButlerTurns ?? "∞"}.`
              }
            ],
            details: {
              supervision,
              thread: this.store.getThread(typedParams.threadId) ?? null
            }
          };
        }
      }),
      this.defineButlerTool({
        name: "delete_job",
        label: "Delete job",
        description: "Permanently delete one Codex job thread and its local session artifacts.",
        promptSnippet: "delete_job: remove one Codex job thread when the operator explicitly asks for deletion.",
        parameters: Type.Object({
          threadId: Type.String()
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "delete_job")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string };
          const result = await this.codexClient.deleteThread(typedParams.threadId);
          return {
            content: [{ type: "text", text: `Deleted job ${typedParams.threadId}.` }],
            details: result
          };
        }
      }),
      this.defineButlerTool({
        name: "delete_all_jobs",
        label: "Delete all jobs",
        description: "Permanently delete all Codex job threads and their local session artifacts.",
        promptSnippet: "delete_all_jobs: remove all Codex job threads only when the operator explicitly asks for a full cleanup.",
        parameters: Type.Object({}),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "delete_all_jobs")?.uiEffects ?? [],
        execute: async () => {
          const result = await this.codexClient.deleteAllThreads();
          return {
            content: [{ type: "text", text: `Deleted ${result.deletedThreadIds.length} jobs.` }],
            details: result
          };
        }
      })
    ];
  }

  private async createOrRefreshSession(): Promise<void> {
    if (!this.modelRegistry) {
      throw new Error("Butler model registry is not ready");
    }

    this.unsubscribeSession?.();
    this.unsubscribeSession = null;

    await this.sanitizePersistedSessions();

    const authStorage = AuthStorage.create(this.piAuthPath);
    const preferredModel =
      this.auth.mode === "chatgpt" ? getModel("openai-codex", "gpt-5.4") : getModel("openai", "gpt-5.4");
    const resourceLoader = new DefaultResourceLoader({
      systemPromptOverride: () => buildSystemPrompt(this.store)
    });
    await resourceLoader.reload();

    this.session = (
      await createAgentSession({
        cwd: "/repos",
        authStorage,
        modelRegistry: this.modelRegistry,
        model: preferredModel,
        tools: [],
        customTools: this.buildCustomTools(),
        sessionManager: SessionManager.continueRecent("/repos", this.sessionDir),
        resourceLoader
      })
    ).session;

    this.sanitizeSessionMessages();
    this.dropTrailingFailedTurns();

    this.compaction = {
      lastReason: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastTokensBefore: null,
      lastWillRetry: false,
      lastAborted: false,
      lastError: null
    };
    this.restoreCompactionState();

    this.unsubscribeSession = this.session.subscribe((event) => {
      if (event.type === "compaction_start") {
        this.compaction.lastReason = event.reason;
        this.compaction.lastStartedAt = Date.now();
        this.compaction.lastError = null;
        this.compaction.lastAborted = false;
      }

      if (event.type === "compaction_end") {
        this.compaction.lastReason = event.reason;
        this.compaction.lastCompletedAt = Date.now();
        this.compaction.lastWillRetry = event.willRetry;
        this.compaction.lastAborted = event.aborted;
        this.compaction.lastError = event.errorMessage ?? null;
        this.compaction.lastTokensBefore = event.result?.tokensBefore ?? this.compaction.lastTokensBefore;
      }

      this.ready = true;
      this.emit("change");
    });
  }

  private async sanitizePersistedSessions(): Promise<void> {
    const entries = await fs.readdir(this.sessionDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(this.sessionDir, entry.name);
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw.split("\n");
      let changed = false;
      const nextLines = lines.map((line) => {
        if (!line.trim()) {
          return line;
        }

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type !== "message" || !parsed.message || typeof parsed.message !== "object") {
            return line;
          }

          const sanitized = sanitizeHistoryMessage(parsed.message);
          if (!sanitized.changed) {
            return line;
          }

          changed = true;
          return JSON.stringify({
            ...parsed,
            message: sanitized.message
          });
        } catch {
          return line;
        }
      });

      if (changed) {
        await fs.writeFile(filePath, nextLines.join("\n"), "utf8");
      }
    }
  }

  private restoreCompactionState(): void {
    if (!this.session) {
      return;
    }

    const compactions = this.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    const latestCompaction = compactions.at(-1);

    if (!latestCompaction) {
      return;
    }

    this.compaction.lastCompletedAt = Date.parse(latestCompaction.timestamp);
    this.compaction.lastTokensBefore = latestCompaction.tokensBefore;
  }

  private getContextUsage(): ButlerContextUsageView {
    const contextUsage = this.session?.getSessionStats().contextUsage;

    return {
      tokens: contextUsage?.tokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? null,
      percent: contextUsage?.percent ?? null
    };
  }

  private getCompactionSnapshot(): ButlerCompactionView {
    if (!this.session) {
      return {
        autoEnabled: true,
        active: false,
        count: 0,
        ...this.compaction
      };
    }

    const count = this.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;

    return {
      autoEnabled: this.session.autoCompactionEnabled,
      active: this.session.isCompacting,
      count,
      ...this.compaction
    };
  }

  private async runPrompt(text: string, imageReferenceIds: string[] = []): Promise<void> {
    if (!this.session) {
      throw new Error("Butler agent is not ready");
    }

    try {
      await this.session.prompt(text, {
        ...(this.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
        images: await this.imageStore.loadPiImages(imageReferenceIds)
      });
    } finally {
      this.sanitizeSessionMessages();
    }

    const latestFailure = this.extractLatestAssistantFailure();
    if (latestFailure) {
      this.dropTrailingFailedTurns();
      throw new Error(latestFailure);
    }
  }

  private extractLatestAssistantFailure(): string | null {
    if (!this.session) {
      return null;
    }

    for (let index = this.session.messages.length - 1; index >= 0; index -= 1) {
      const message = this.session.messages[index];
      if (!message || typeof message !== "object") {
        continue;
      }

      if ((message as { role?: string }).role !== "assistant") {
        continue;
      }

      if (!isAssistantFailureMessage(message)) {
        return null;
      }

      return typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? message.errorMessage.trim()
        : "Butler request failed.";
    }

    return null;
  }

  private dropTrailingFailedTurns(): void {
    if (!this.session) {
      return;
    }

    const trimmedMessages = [...this.session.messages];
    let changed = false;

    while (trimmedMessages.length > 0) {
      const lastMessage = trimmedMessages.at(-1);
      if (!isAssistantFailureMessage(lastMessage)) {
        break;
      }

      trimmedMessages.pop();
      changed = true;

      while (trimmedMessages.length > 0) {
        const previousMessage = trimmedMessages.at(-1);
        if (
          previousMessage &&
          typeof previousMessage === "object" &&
          (previousMessage as { role?: string }).role === "assistant"
        ) {
          break;
        }

        trimmedMessages.pop();
      }
    }

    if (!changed) {
      return;
    }

    this.session.agent.state.messages = trimmedMessages;
  }

  private sanitizeSessionMessages(): void {
    if (!this.session) {
      return;
    }

    const sanitized = sanitizeHistoryMessages(this.session.messages);
    if (!sanitized.changed) {
      return;
    }

    this.session.agent.state.messages = sanitized.messages;
  }

  private getVisibleMessages(): ButlerMessageView[] {
    const sessionMessages = this.session ? serializeMessages(this.session) : [];
    return mergeVisibleMessages(sessionMessages, this.noticeMessages);
  }

  getMessagePage(before: number | null, limit: number): ButlerMessagePageView {
    const visibleMessages = this.getVisibleMessages();
    const totalCount = visibleMessages.length;
    const cappedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : SNAPSHOT_MESSAGE_TAIL_LIMIT, MAX_HISTORY_PAGE_SIZE));
    const safeBefore =
      typeof before === "number" && Number.isFinite(before)
        ? Math.max(0, Math.min(Math.trunc(before), totalCount))
        : totalCount;
    const startIndex = Math.max(0, safeBefore - cappedLimit);

    return {
      messages: visibleMessages.slice(startIndex, safeBefore),
      startIndex,
      endIndex: safeBefore,
      totalCount,
      hasMore: startIndex > 0
    };
  }

  getLiveSnapshot(): ButlerLiveSnapshot {
    const visibleMessages = this.getVisibleMessages();
    const messageCount = visibleMessages.length;

    return {
      messages: visibleMessages.slice(Math.max(0, messageCount - SNAPSHOT_MESSAGE_TAIL_LIMIT)),
      messageCount
    };
  }

  getShellSnapshot(): AppShellSnapshot["butler"] {
    const codexCompose = this.codexClient.getConnectionState().compose;
    const availableModels = codexCompose.availableModels;
    const availableThinkingLevels = ["low", "medium", "high", "xhigh"] as ButlerThinkingLevel[];
    const currentThinkingLevel = availableThinkingLevels.includes(this.session?.thinkingLevel as ButlerThinkingLevel)
      ? (this.session?.thinkingLevel as ButlerThinkingLevel)
      : "medium";

    return {
      ready: this.ready,
      pending: this.pending,
      isStreaming: this.session?.isStreaming ?? false,
      sessionId: this.session?.sessionId ?? null,
      model: this.session?.model?.id ?? null,
      auth: this.auth,
      tools: this.toolCatalog,
      onboarding: this.onboarding,
      contextUsage: this.getContextUsage(),
      compaction: this.getCompactionSnapshot(),
      supervision: {
        projects: this.store.listProjectSummaries(),
        supervisor: this.store.getSupervisorSummary(),
        notices: this.noticeMessages
      },
      lastError: this.lastError,
      compose: {
        provider: this.session?.model?.provider ?? null,
        model: this.session?.model?.id ?? null,
        thinkingLevel: currentThinkingLevel,
        availableThinkingLevels,
        availableModels
      }
    };
  }

  getSnapshot(): AppSnapshot["butler"] {
    const liveSnapshot = this.getLiveSnapshot();
    const shellSnapshot = this.getShellSnapshot();

    return {
      ...shellSnapshot,
      ...liveSnapshot,
      latestPreviewProofsByThreadId: Object.fromEntries(
        this.store
          .listPreviewProofs()
          .filter((proof) => Boolean(proof.threadId))
          .reduce((accumulator, proof) => {
            if (!proof.threadId || accumulator.has(proof.threadId)) {
              return accumulator;
            }
            accumulator.set(proof.threadId, proof);
            return accumulator;
          }, new Map<string, PreviewProofRecordView>())
          .entries()
      ),
      stacks: this.store.listStackLeases(),
      previews: this.store.listPreviewLeases(),
      serviceTemplates: this.serviceTemplates,
      services: this.store.listServiceLeases(),
    };
  }

  prompt(text: string, imageReferenceIds: string[] = []): void {
    if (!this.session) {
      throw new Error("Butler agent is not ready");
    }

    this.pending = true;
    this.lastError = null;
    this.emit("change");

    const execute = async () => {
      try {
        const nextAuth = await readButlerAuthStatus(this.piAuthPath);
        if (nextAuth.mode !== this.auth.mode || nextAuth.loggedIn !== this.auth.loggedIn) {
          this.auth = nextAuth;
          this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
          await this.createOrRefreshSession();
        } else {
          this.auth = nextAuth;
        }
        await this.runPrompt(text, imageReferenceIds);
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        await this.refreshExternalStatus();
        this.pending = false;
        this.emit("change");
      }
    };

    this.promptQueue = this.promptQueue.then(execute, execute);
  }

  async updateComposeSettings(provider: string, modelId: string, thinkingLevel: ButlerThinkingLevel): Promise<void> {
    if (!this.session || !this.modelRegistry) {
      throw new Error("Butler agent is not ready");
    }

    const lookupProviders = provider
      ? [provider]
      : this.auth.mode === "chatgpt"
        ? ["openai-codex", "openai"]
        : ["openai", "openai-codex"];

    const model = lookupProviders
      .map((candidateProvider) => this.modelRegistry?.find(candidateProvider, modelId))
      .find(Boolean);
    if (!model) {
      throw new Error("Selected Butler model is not available");
    }

    await this.session.setModel(model);
    this.session.setThinkingLevel(thinkingLevel === "off" || thinkingLevel === "minimal" ? "medium" : thinkingLevel);
    this.lastError = null;
    this.emit("change");
  }
}
