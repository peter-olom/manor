import type { ButlerToolView } from "./types.js";

export const BUTLER_TOOL_CATALOG: ButlerToolView[] = [
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
    description: "List the registered Manor service templates Butler can provision for app stacks.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while choosing a service template." }]
  },
  {
    name: "register_service_template",
    label: "Register service template",
    description: "Persist one dependency service template so future jobs can reuse it without redefining the runtime details.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes newly registered dependency templates available immediately." }]
  },
  {
    name: "start_service",
    label: "Start service",
    description: "Provision a disposable dependency service such as Postgres, Redis, MySQL, MSSQL, RabbitMQ, MinIO, Mailpit, SQLite, or another registered template for one job.",
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
    description: "Inspect one dependency service and return its current connection details and runtime state.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes one service lease before Butler acts on it." }]
  },
  {
    name: "service_logs",
    label: "Service logs",
    description: "Read recent logs from one container-backed dependency service.",
    uiEffects: [{ kind: "refreshThreads", description: "Lets Butler inspect one service without opening a shell." }]
  },
  {
    name: "exec_service",
    label: "Exec in service",
    description: "Run one shell command inside a container-backed dependency service.",
    uiEffects: [{ kind: "refreshThreads", description: "Lets Butler inspect or patch one service directly." }]
  },
  {
    name: "stop_service",
    label: "Stop service",
    description: "Stop one disposable dependency service and release its lease.",
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
