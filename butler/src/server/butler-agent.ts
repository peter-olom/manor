import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getModel } from "@mariozechner/pi-ai";
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
import { ensureTaskWorktree } from "./repo-worktree.js";
import { RuntimeBrokerClient } from "./runtime-broker-client.js";
import { type LoadedServiceTemplate, toServiceLeaseView } from "./service-templates.js";
import { formatStackStorageSummary, normalizeStackStorageMode } from "./stack-storage.js";
import type {
  AppSnapshot,
  ButlerAuthStatus,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerMessageView,
  ButlerMessagePageView,
  ButlerOnboardingView,
  ButlerThinkingLevel,
  ButlerToolUiEffect,
  ButlerToolView,
  ModelOption
} from "./types.js";
import { ButlerStateStore } from "./state-store.js";
import { CodexAppServerClient } from "./codex-client.js";

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
    "When a project needs common dev dependencies like Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, or SQLite, prefer the built-in service templates instead of ad hoc install steps.",
    "Codex may operate inside attached isolates through manor-harness for inspect, logs, processes, and shell exec, but Butler still owns isolate lifecycle and policy.",
    "When the operator provides reference images, keep track of the stored image references so you can pass them to Codex later and reuse them during verification.",
    "Use the image reference tools whenever visual requirements depend on an uploaded image.",
    "",
    `Supervisor state: ${supervisor.summary}`,
    projects.length > 0 ? "Project summaries:" : "Project summaries: none yet.",
    ...projects.map((project) => `- ${project.label}: ${project.summary}`)
  ].join("\n");
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
    this.noticeStatePath = path.join(this.sessionDir, "notices.json");
    this.toolCatalog = this.buildToolCatalog();
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
    const worktree = await ensureTaskWorktree({
      cwd: requestedCwd,
      task
    });

    return {
      cwd: worktree.cwd,
      branchName: worktree.branchName
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

    const stack = this.store.getStackLease(stackId);
    if (!stack) {
      throw new Error(`Unknown stack: ${stackId}`);
    }

    if (threadId && stack.threadId && stack.threadId !== threadId) {
      throw new Error(`Stack ${stackId} belongs to a different job`);
    }

    return stack;
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
          const stack = await this.runtimeBroker.createStack({
            stackId: crypto.randomUUID(),
            threadId: typedParams.threadId ?? null,
            projectId: thread?.supervisor.projectId ?? "stack",
            projectLabel: thread?.supervisor.projectLabel ?? "stack",
            title: typedParams.title.trim(),
            worktreePath: typedParams.cwd?.trim() || thread?.cwd || null,
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
          const leases = this.store.listPreviewLeases();
          const text =
            leases.length === 0
              ? "No preview leases are active."
              : leases
                  .map(
                    (lease, index) =>
                      `${index + 1}. ${lease.title} | thread=${lease.threadId ?? "(none)"} | status=${lease.status}/${lease.bootstrap.phase} | route=${lease.operatorUrl}`
                  )
                  .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { previews: leases }
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
              description: "Use 'none' for no outbound access or a named preview egress profile such as 'web'."
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
          const projectId = thread?.supervisor.projectId ?? "preview";
          const projectLabel = thread?.supervisor.projectLabel ?? "preview";
          const leaseId = crypto.randomUUID();
          const worktreePath = typedParams.cwd?.trim() || stack?.worktreePath || thread?.cwd || "";

          if (!worktreePath) {
            throw new Error("start_preview requires a cwd or a stack with a worktree path");
          }

          const lease = await this.runtimeBroker.createLease({
            leaseId,
            threadId: typedParams.threadId ?? null,
            projectId,
            projectLabel,
            title: typedParams.title,
            stackId: stack?.id ?? null,
            aliases: this.normalizeStringArray(typedParams.aliases),
            worktreePath,
            branchName: thread?.cwd === typedParams.cwd ? null : null,
            targetPort: typedParams.port,
            command: typedParams.command,
            image: typedParams.image,
            egressProfile: typedParams.egressProfile ?? "none",
            egressDomains: typedParams.egressDomains ?? [],
            bootstrapWaitSeconds: typedParams.bootstrapWaitSeconds,
            bootstrapHint: typedParams.bootstrapHint,
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
                text: `Started preview ${lease.title} at ${lease.operatorUrl}. Bootstrap=${lease.bootstrap.phase}${lease.bootstrap.hint ? ` (${lease.bootstrap.hint})` : ""}.`
              }
            ],
            details: { lease }
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

          if (template.runtimeKind === "embedded") {
            const filePath = `${worktreePath}/${template.fileName ?? ".manor/sqlite/app.db"}`.replace(/\/+/g, "/");
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            const handle = await fs.open(filePath, "a");
            await handle.close();
            const lease = toServiceLeaseView({
              id: serviceId,
              threadId: typedParams.threadId ?? null,
              projectId: thread?.supervisor.projectId ?? "service",
              projectLabel: thread?.supervisor.projectLabel ?? "service",
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
            projectId: thread?.supervisor.projectId ?? "service",
            projectLabel: thread?.supervisor.projectLabel ?? "service",
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
          const services = this.store.listServiceLeases();
          const text =
            services.length === 0
              ? "No disposable services are active."
              : services
                  .map(
                    (service, index) =>
                      `${index + 1}. ${service.title} | template=${service.templateId} | status=${service.status} | storage=${service.storageKind}${service.volumeName ? `(${service.volumeName})` : ""} | host=${service.connection.host} | port=${service.connection.port} | uri=${service.connection.uri ?? "(none)"}`
                  )
                  .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { services }
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
          const existing = this.store.getServiceLease(typedParams.serviceId);
          if (!existing) {
            return {
              content: [{ type: "text", text: `Service ${typedParams.serviceId} was not found.` }],
              details: { service: null }
            };
          }
          if (existing.runtimeKind === "embedded") {
            this.store.noteServiceLeaseActivity(typedParams.serviceId);
            return {
              content: [{ type: "text", text: `${existing.title} is embedded at ${existing.connection.uri ?? existing.worktreePath ?? "(unknown path)"}.` }],
              details: { service: existing }
            };
          }
          const inspected = await this.runtimeBroker.inspectService(typedParams.serviceId);
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
          this.store.noteServiceLeaseActivity(typedParams.serviceId);
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
          const service = this.store.getServiceLease(typedParams.serviceId);
          if (!service) {
            return {
              content: [{ type: "text", text: `Service ${typedParams.serviceId} was not found.` }],
              details: { service: null }
            };
          }
          if (service.runtimeKind !== "container") {
            this.store.noteServiceLeaseActivity(typedParams.serviceId);
            return {
              content: [{ type: "text", text: `${service.title} is embedded and does not expose container logs.` }],
              details: { service }
            };
          }
          const result = await this.runtimeBroker.readServiceLogs(typedParams.serviceId, typedParams.tail ?? 200);
          this.store.noteServiceLeaseActivity(typedParams.serviceId);
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
          const service = this.store.getServiceLease(typedParams.serviceId);
          if (!service) {
            return {
              content: [{ type: "text", text: `Service ${typedParams.serviceId} was not found.` }],
              details: { service: null }
            };
          }
          if (service.runtimeKind !== "container") {
            this.store.noteServiceLeaseActivity(typedParams.serviceId);
            return {
              content: [{ type: "text", text: `${service.title} is embedded and does not support container exec.` }],
              details: { service }
            };
          }
          const result = await this.runtimeBroker.execInService(typedParams);
          this.store.noteServiceLeaseActivity(typedParams.serviceId);
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
          const service = this.store.getServiceLease(typedParams.serviceId);
          if (!service) {
            return {
              content: [{ type: "text", text: `Service ${typedParams.serviceId} was not found.` }],
              details: { service: null }
            };
          }
          if (service.runtimeKind === "container") {
            await this.runtimeBroker.stopService(typedParams.serviceId);
          }
          this.store.removeServiceLease(typedParams.serviceId);
          return {
            content: [{ type: "text", text: `Stopped ${service.title}.` }],
            details: { serviceId: typedParams.serviceId }
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
          return {
            content: [{ type: "text", text: buildJobDetail(this.store, typedParams.threadId) }],
            details: {
              thread: this.store.getThread(typedParams.threadId) ?? null
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
            `Work inside ${workspace.cwd} unless the task explicitly requires a deeper subdirectory.`,
            workspace.branchName
              ? `Stay on branch ${workspace.branchName}. Do not switch back to main or share this branch with another task.`
              : "When the task touches git in a repository, create or reuse a dedicated branch whose name starts with butler/.",
            "If this job needs a preview isolate, a disposable service, or runtime inspection, use the local `manor-harness` command from this workspace.",
            "Start with `manor-harness status` to see what Manor already attached to this job.",
            "If the work needs multiple cooperating services, create a stack first with `manor-harness stack start`, then attach previews and services to it with `--stack <stackId>` and stable `--alias` names that mirror the app's expected internal hostnames.",
            "When a stack needs recurring databases or object storage, start it with `manor-harness stack start --stateful` so Manor derives a per-job retained storage key, forks from the project base, and sets the default promotion target automatically.",
            "Use `--storage-mode base` only when you are intentionally creating or refreshing the shared base state for that project. Do not share one writable database volume across concurrent jobs.",
            "After validating a job-scoped stateful stack, use `manor-harness stack promote <stackId>` to publish its retained data back to the project base. Only override the target manually when the task explicitly needs a different namespace.",
            "For attached previews and services, use `manor-harness` for inspect, logs, processes, and exec directly against the runtime. Butler still owns start, stop, lifecycle, and policy.",
            "Use only the harness actions exposed through `manor-harness`. Do not try to command Butler directly outside those actions.",
            "When you complete meaningful work, record a supervisor report before your final reply with `manor-harness report --status completed --summary \"<concise outcome>\" --details \"<brief oversight note with the key fact, risk, or next step>\"`.",
            "If you are blocked or need operator attention, record it before your reply with `manor-harness report --status blocked --summary \"<what is blocked>\" --details \"<what you need, what failed, or the next recommended action>\"`.",
            "Supervisor reports should help Butler oversee the job. Keep `summary` short and outcome-first, and use `details` for the extra context Butler should surface without dumping the whole conversation.",
            "Keep the thread focused on the delegated task and report concise progress and outcome."
          ].join("\n");

          const prompt = typedParams.goal ? `${typedParams.task}\n\nGoal: ${typedParams.goal}` : typedParams.task;
          const result = await this.codexClient.startThread({
            task: prompt,
            input: this.imageStore.buildCodexInput(prompt, typedParams.imageReferenceIds ?? []),
            cwd: workspace.cwd,
            developerInstructions,
            openWindow: true
          });
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
        description: "Privately send a follow-up instruction into one Codex job thread without surfacing the full steering text in Butler chat.",
        promptSnippet: "message_job: steer a Codex job privately, then summarize the state for the operator.",
        parameters: Type.Object({
          threadId: Type.String(),
          text: Type.String({ minLength: 1 }),
          imageReferenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "message_job")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string; text: string; imageReferenceIds?: string[] };
          const limitMessage = this.getThreadBudgetLimitMessage(typedParams.threadId);
          if (limitMessage) {
            return {
              content: [{ type: "text", text: limitMessage }],
              details: {
                thread: this.store.getThread(typedParams.threadId) ?? null,
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

    await this.session.prompt(text, {
      ...(this.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      images: await this.imageStore.loadPiImages(imageReferenceIds)
    });

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

      const previousMessage = trimmedMessages.at(-1);
      if (previousMessage && typeof previousMessage === "object" && (previousMessage as { role?: string }).role === "user") {
        trimmedMessages.pop();
      }
    }

    if (!changed) {
      return;
    }

    this.session.agent.state.messages = trimmedMessages;
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

  getSnapshot(): AppSnapshot["butler"] {
    const codexCompose = this.codexClient.getConnectionState().compose;
    const availableModels = codexCompose.availableModels;
    const availableThinkingLevels = ["low", "medium", "high", "xhigh"] as ButlerThinkingLevel[];
    const currentThinkingLevel = availableThinkingLevels.includes(this.session?.thinkingLevel as ButlerThinkingLevel)
      ? (this.session?.thinkingLevel as ButlerThinkingLevel)
      : "medium";
    const visibleMessages = this.getVisibleMessages();
    const messageCount = visibleMessages.length;
    const messages = visibleMessages.slice(Math.max(0, messageCount - SNAPSHOT_MESSAGE_TAIL_LIMIT));

    return {
      ready: this.ready,
      pending: this.pending,
      isStreaming: this.session?.isStreaming ?? false,
      sessionId: this.session?.sessionId ?? null,
      model: this.session?.model?.id ?? null,
      auth: this.auth,
      messages,
      messageCount,
      tools: this.toolCatalog,
      onboarding: this.onboarding,
      contextUsage: this.getContextUsage(),
      compaction: this.getCompactionSnapshot(),
      supervision: {
        projects: this.store.listProjectSummaries(),
        supervisor: this.store.getSupervisorSummary(),
        notices: this.noticeMessages
      },
      stacks: this.store.listStackLeases(),
      previews: this.store.listPreviewLeases(),
      serviceTemplates: this.serviceTemplates,
      services: this.store.listServiceLeases(),
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
