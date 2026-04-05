import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";

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
import type {
  AppSnapshot,
  ButlerAuthStatus,
  ButlerCompactionView,
  ButlerContextUsageView,
  ButlerMessageView,
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
      return {
        id: `message-${index}`,
        role,
        text: "content" in message ? contentToText(message.content) : "",
        at: extractMessageTimestamp(record)
      };
    });

  return messages.filter((message, index) => {
    if (!(message.role === "user" || message.role === "assistant" || message.role === "user-with-attachments")) {
      return false;
    }

    if (message.role === "assistant" && !message.text.trim()) {
      return session.isStreaming && index === messages.length - 1;
    }

    return true;
  });
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
    "When work touches git in a repo, enforce a dedicated branch whose name starts with butler/.",
    "Do not run two parallel Codex workstreams on the same repo branch.",
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

export class ButlerAgentService extends EventEmitter {
  private readonly store: ButlerStateStore;
  private readonly codexClient: CodexAppServerClient;
  private readonly piAuthPath: string;
  private readonly codexAuthPath: string;
  private readonly codexConfigDir: string;
  private readonly sessionDir: string;
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
    piAuthPath: string;
    codexAuthPath: string;
    codexConfigDir: string;
    sessionDir: string;
  }) {
    super();
    this.store = options.store;
    this.codexClient = options.codexClient;
    this.piAuthPath = options.piAuthPath;
    this.codexAuthPath = options.codexAuthPath;
    this.codexConfigDir = options.codexConfigDir;
    this.sessionDir = options.sessionDir;
    this.toolCatalog = this.buildToolCatalog();
  }

  private handleStoreChange(): void {
    let changed = false;

    for (const milestone of this.store.listMilestones()) {
      if (milestone.type !== "completed" && milestone.type !== "blocked") {
        continue;
      }

      if (this.seenMilestoneIds.has(milestone.id)) {
        continue;
      }

      this.seenMilestoneIds.add(milestone.id);
      this.noticeMessages.push({
        id: `notice-${milestone.id}`,
        role: "assistant",
        text: milestone.type === "blocked" ? `Codex reported a blocked workstream. ${milestone.summary}` : `Codex finished work. ${milestone.summary}`,
        at: milestone.at
      });
      changed = true;
    }

    if (changed) {
      this.noticeMessages.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
      if (this.noticeMessages.length > 40) {
        this.noticeMessages.splice(0, this.noticeMessages.length - 40);
      }
      this.emit("change");
    }
  }

  async start(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    this.auth = await readButlerAuthStatus(this.piAuthPath);
    this.modelRegistry = ModelRegistry.inMemory(AuthStorage.create(this.piAuthPath));
    await this.createOrRefreshSession();
    await this.refreshExternalStatus();
    this.store.on("change", () => this.handleStoreChange());
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
        name: "list_jobs",
        label: "List jobs",
        description: "List Codex jobs, their statuses, and short previews.",
        uiEffects: [{ kind: "refreshThreads", description: "Keeps the run list current." }]
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

  private buildCustomTools() {
    return [
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
        name: "delegate_to_codex",
        label: "Delegate to Codex",
        description: "Start a new Codex workstream for an execution task such as repo cloning, project setup, coding work, or command execution.",
        promptSnippet: "delegate_to_codex: use this when the operator wants Butler to actually make Codex do work instead of just answering with instructions.",
        parameters: Type.Object({
          task: Type.String({ minLength: 1 }),
          cwd: Type.Optional(Type.String()),
          goal: Type.Optional(Type.String())
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "delegate_to_codex")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { task: string; cwd?: string; goal?: string };
          const developerInstructions = [
            "This thread was started by Butler.",
            "Execute the requested task directly instead of explaining how the operator could do it manually.",
            "Work inside /repos unless the task explicitly requires a deeper subdirectory.",
            "When the task touches git in a repository, create or reuse a dedicated branch whose name starts with butler/.",
            "Keep the thread focused on the delegated task and report concise progress and outcome."
          ].join("\n");

          const prompt = typedParams.goal ? `${typedParams.task}\n\nGoal: ${typedParams.goal}` : typedParams.task;
          const result = await this.codexClient.startThread({
            task: prompt,
            cwd: typedParams.cwd ?? "/repos",
            developerInstructions,
            openWindow: true
          });

          return {
            content: [{ type: "text", text: `Delegated the task to Codex in job ${result.threadId}.` }],
            details: {
              threadId: result.threadId,
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
          text: Type.String({ minLength: 1 })
        }),
        uiEffects: this.toolCatalog.find((tool) => tool.name === "message_job")?.uiEffects ?? [],
        execute: async (_toolCallId, params) => {
          const typedParams = params as { threadId: string; text: string };
          await this.codexClient.loadThread(typedParams.threadId);
          await this.codexClient.sendMessage(typedParams.threadId, typedParams.text);
          return {
            content: [{ type: "text", text: `Sent a private follow-up to job ${typedParams.threadId}.` }],
            details: {
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

  private async runPrompt(text: string): Promise<void> {
    if (!this.session) {
      throw new Error("Butler agent is not ready");
    }
    await this.session.prompt(text, this.session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
  }

  getSnapshot(): AppSnapshot["butler"] {
    const codexCompose = this.codexClient.getConnectionState().compose;
    const availableModels = codexCompose.availableModels;
    const availableThinkingLevels = ["low", "medium", "high", "xhigh"] as ButlerThinkingLevel[];
    const currentThinkingLevel = availableThinkingLevels.includes(this.session?.thinkingLevel as ButlerThinkingLevel)
      ? (this.session?.thinkingLevel as ButlerThinkingLevel)
      : "medium";
    const sessionMessages = this.session ? serializeMessages(this.session) : [];

    return {
      ready: this.ready,
      pending: this.pending,
      isStreaming: this.session?.isStreaming ?? false,
      sessionId: this.session?.sessionId ?? null,
      model: this.session?.model?.id ?? null,
      auth: this.auth,
      messages: mergeVisibleMessages(sessionMessages, this.noticeMessages),
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

  prompt(text: string): void {
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
        await this.runPrompt(text);
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
