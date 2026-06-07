import type { ButlerToolView } from "./types.js";

export const BUTLER_TOOL_CATALOG: ButlerToolView[] = [
  {
    name: "prepare_worktree",
    label: "Prepare worktree",
    description: "Create an explicitly requested isolated branch and git worktree for one repo task.",
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
    name: "set_stack_lease",
    label: "Set stack lease",
    description: "Update stack lease lifecycle, including sticky reuse and cleanup TTL.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes stack lease retention state." }]
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
    name: "set_preview_lease",
    label: "Set preview lease",
    description: "Update preview lease lifecycle, including sticky reuse and cleanup TTL.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes preview lease retention state." }]
  },
  {
    name: "start_preview_browser_session",
    label: "Start preview browser session",
    description: "Attach a browser sidecar to one preview and begin a live recorded session.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes preview state when a browser session begins." }]
  },
  {
    name: "start_browser_session",
    label: "Start browser session",
    description: "Start a live recorded browser session for a direct URL.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes thread state when a browser session begins." }]
  },
  {
    name: "browser_session_state",
    label: "Browser session state",
    description: "Inspect one active browser session state before further actions.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while monitoring live browser state." }]
  },
  {
    name: "browser_session_action",
    label: "Browser session action",
    description: "Execute one explicit action in an active browser session, including manual screenshots.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while driving a live browser session." }]
  },
  {
    name: "stop_browser_session",
    label: "Stop browser session",
    description: "Stop one browser session and persist the final proof bundle (video plus screenshots).",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes proof state after browser session finalization." }]
  },
  {
    name: "desktop_proof_status",
    label: "Desktop proof status",
    description: "Check whether headed desktop proof is available.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes desktop sidecar availability." }]
  },
  {
    name: "list_desktop_sessions",
    label: "List desktop sessions",
    description: "List active headed desktop sessions, attached threads, and workspace labels visible in noVNC.",
    uiEffects: [{ kind: "refreshThreads", description: "Keeps desktop session state current." }]
  },
  {
    name: "start_desktop_session",
    label: "Start desktop session",
    description: "Start a headed desktop session for Electron or native app proof, attached to a thread workspace.",
    uiEffects: [{ kind: "refreshThreads", description: "Shows the new desktop session in runtime controls." }]
  },
  {
    name: "desktop_current_screen",
    label: "Current desktop screen",
    description: "Capture screenshot, windows, pointer, and display geometry for a headed desktop session.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes desktop session proof state." }]
  },
  {
    name: "desktop_session_action",
    label: "Desktop session action",
    description: "Run explicit clicks, keys, OCR targeting, locks, CDP inspection, or clipboard actions in a desktop session.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while driving a desktop session." }]
  },
  {
    name: "stop_desktop_session",
    label: "Stop desktop session",
    description: "Stop a headed desktop session and persist screenshots, logs, and action history.",
    uiEffects: [{ kind: "refreshThreads", description: "Refreshes proof state after desktop session finalization." }]
  },
  {
    name: "review_preview_proof",
    label: "Review proof",
    description: "Inspect the latest browser, desktop, or file proof for one preview or job. UI-impacting work needs screenshot or video proof.",
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
    description: "Run one shell command or argv-style process inside a preview isolate through the runtime broker.",
    uiEffects: [{ kind: "refreshThreads", description: "Lets Butler actively diagnose or fix one preview isolate." }]
  },
  {
    name: "list_service_templates",
    label: "List service templates",
    description: "List the registered Manor service templates Butler can provision for app stacks.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while choosing a service template." }]
  },
  {
    name: "remember_insight",
    label: "Remember insight",
    description: "Store a durable Butler memory from the main chat.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes new Butler memory available immediately." }]
  },
  {
    name: "retrieve_memory",
    label: "Retrieve memory",
    description: "Retrieve a scoped durable memory brief for project work, job follow-ups, and prior decisions.",
    uiEffects: [{ kind: "focusButler", description: "Keeps memory retrieval scoped before Butler answers or acts." }]
  },
  {
    name: "list_project_artifacts",
    label: "List project artifacts",
    description: "List or search durable project artifacts such as saved seeds, downloads, and reusable analysis files.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while choosing reusable project files." }]
  },
  {
    name: "save_project_artifact",
    label: "Save project artifact",
    description: "Persist a durable text artifact for the current project outside the repo.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes newly stored project artifacts available immediately." }]
  },
  {
    name: "share_project_file",
    label: "Share project file",
    description: "Persist an existing local file as a durable project artifact and return a download link.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes newly shared project files available immediately." }]
  },
  {
    name: "download_project_artifact",
    label: "Download project artifact",
    description: "Download a file from a URL and persist it as a durable project artifact.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes downloaded project artifacts available immediately." }]
  },
  {
    name: "read_project_artifact",
    label: "Read project artifact",
    description: "Read one stored project artifact and its text content when applicable.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while inspecting a stored artifact." }]
  },
  {
    name: "list_project_policies",
    label: "List project policies",
    description: "List durable project policies Butler can surface or apply when matching events happen.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while reviewing remembered rules." }]
  },
  {
    name: "remember_project_policy",
    label: "Remember project policy",
    description: "Create or update a durable instruction bundle with triggers and artifact references.",
    uiEffects: [{ kind: "refreshThreads", description: "Makes new remembered project behavior available immediately." }]
  },
  {
    name: "invoke_project_policy",
    label: "Invoke project policy",
    description: "Load or execute one remembered policy directly by id, title, or alias.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler supervising while a remembered policy is applied or loaded." }]
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
    description: "List Codex jobs/threads across statuses, including active and inactive jobs.",
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
    description: "Read one specific Codex job/thread in detail by thread id.",
    uiEffects: [{ kind: "refreshThread", description: "Loads the latest run transcript into Butler." }]
  },
  {
    name: "list_projects",
    label: "List projects",
    description: "List known project directories, nested Git repositories, and current tracked work separately.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while checking project inventory and workstream activity." }]
  },
  {
    name: "read_project",
    label: "Read group",
    description: "Read the current summary for one workstream group and its tracked Codex threads.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while inspecting one workstream group." }]
  },
  {
    name: "supervisor_overview",
    label: "Supervisor overview",
    description: "Return the top-level supervisor summary across all tracked Codex workstream groups and threads.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler anchored in the main supervisor thread." }]
  },
  {
    name: "delegate_to_codex",
    label: "Delegate to Codex",
    description: "Start a new Codex workstream for an execution task such as repo cloning, project setup, coding work, or command execution, with an optional thinking budget.",
    uiEffects: [
      { kind: "openWindow", description: "Opens the delegated Codex workstream as a tab." },
      { kind: "focusWindow", description: "Moves focus into the new Codex workstream." }
    ]
  },
  {
    name: "start_self_improvement",
    label: "Start self-improvement",
    description: "Start a dedicated Manor self-improvement workstream that implements, verifies, pushes a branch, and opens a draft PR.",
    uiEffects: [
      { kind: "openWindow", description: "Opens the Manor self-improvement workstream as a tab." },
      { kind: "focusWindow", description: "Moves focus into the new self-improvement workstream." }
    ]
  },
  {
    name: "request_manor_restart",
    label: "Request Manor restart",
    description: "Open an operator-facing Manor restart/update authorization dialog without mutating the live stack.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while requesting restart authorization." }]
  },
  {
    name: "start_authorized_manor_restart",
    label: "Start authorized restart",
    description: "Consume an operator-authorized Manor restart request and ask the host controller to run it.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while the restart is scheduled." }]
  },
  {
    name: "read_manor_restart_status",
    label: "Restart status",
    description: "Read the active or latest host-controller restart/update run.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler focused while reading restart outcome." }]
  },
  {
    name: "run_supervision_smoke_test",
    label: "Run supervision smoke test",
    description: "Start a synthetic Codex job to verify Butler can privately steer worker callbacks.",
    uiEffects: [
      { kind: "openWindow", description: "Opens the synthetic Codex workstream as a tab." },
      { kind: "focusWindow", description: "Moves focus into the synthetic Codex workstream." }
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
    name: "read_supervision_checklist",
    label: "Read checklist",
    description: "Read one delegated job's structured acceptance points, evidence, Butler decisions, and heartbeat.",
    uiEffects: [{ kind: "focusButler", description: "Keeps Butler in supervisor mode while reviewing structured job state." }]
  },
  {
    name: "review_acceptance_point",
    label: "Review point",
    description: "Record Butler's accept, reject, or waive decision for one acceptance point.",
    uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run after Butler updates checklist state." }]
  },
  {
    name: "flush_rejected_acceptance_points",
    label: "Send rejected points",
    description: "Send one batched private worker follow-up for all queued rejected acceptance points.",
    uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run after Butler sends rejected checklist work back." }]
  },
  {
    name: "hold_job_context",
    label: "Hold context",
    description: "Record newer operator context for an active job without interrupting the worker.",
    uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run after Butler records held context." }]
  },
  {
    name: "message_job",
    label: "Message job",
    description: "Privately send a non-checklist follow-up instruction into one Codex job thread, optionally refreshing a completed checklist for new work, and explicitly decide how the next worker report should be handled.",
    uiEffects: [{ kind: "refreshThread", description: "Refreshes the target run after Butler steers it." }]
  },
  {
    name: "reply_to_operator",
    label: "Reply to operator",
    description: "Post the single operator-visible closeout for one delegated job and close its pending reply obligation.",
    uiEffects: [{ kind: "focusButler", description: "Keeps the main Butler chat aligned with the delegated job outcome." }]
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
