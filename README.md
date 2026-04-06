# Manor

Manor is a personal agent harness built around one idea:

- Codex does the work.
- Butler supervises the work.
- High-trust work stays on a warm agent box.
- Lower-trust web and internet work is pushed into sidecars or disposable runtimes.

## Ambition

Build a dead-simple personal agent system that can:

- stay on all the time,
- manage many repositories,
- expose live Codex threads through a custom client,
- delegate long-running feature and project work,
- let the operator check in occasionally instead of micromanaging every step.

The deployment target is intentionally simple:

- one Docker Compose project on a host,
- operator chooses how beefy the box should be,
- access comes in through Twingate,
- previews, logs, recordings, and agent output stay reachable on the private network.

## Core Model

`Manor` is the whole harness.

`Butler` is the always-on supervisor built on the Pi agent framework.

`Codex Box` is the main trusted worker environment that owns repositories, tools, and long-running coding work.

Supporting services handle the risky edges:

- browser automation,
- internet and package egress,
- optional disposable execution backends,
- recordings and artifact capture.

Preview runtimes are now part of the core model too:

- Codex owns the repo and task worktree
- Butler owns the preview lease
- disposable preview containers run the app on the private Manor network
- Manor exposes a stable operator-facing route for each preview

Common dev dependencies are part of the model too:

- Butler can provision built-in disposable service templates
- Postgres, Redis, MySQL, and MSSQL run as disposable private-network containers
- SQLite is provisioned as an embedded file directly inside the chosen worktree

## Design Principles

- Optimize for usefulness first.
- Be honest about trust boundaries.
- Keep the default deployment simple.
- Separate supervision from execution.
- Keep direct internet off the main Codex box when possible.
- Treat remote content as untrusted even when the worker is trusted.

## Initial Architecture

The first cut of Manor uses these lanes:

- `Butler`: a Pi-based supervisor responsible for heartbeat, scheduling, run supervision, completion checks, and re-prompting when work is incomplete.
- `Codex Box`: trusted coding worker with repo access and local tools.
- `Egress`: dedicated service for dependency installs, research fetches, and controlled outbound traffic.
- `Playwright`: browser automation sidecar for screenshots, previews, flows, and recordings.

Optional external backends can be layered in later:

- `E2B` for a fully open execution sandbox path.
- `Daytona` for a more convenient managed execution path.
- `Kernel` for managed browser sessions when cost is less important than convenience.

## Security Position

Manor does not pretend that full-access Codex inside its worker container is internally sandboxed.

Instead, the initial model is:

- Butler and Codex are separated into different services.
- Codex has no direct internet path.
- Codex reaches OpenAI auth and inference through the egress sidecar only.
- Web and research work go through sidecars.
- Egress is explicit and inspectable.
- The system is a trusted personal worker appliance, not a multi-tenant secure sandbox.

## Repo Layout

- `compose.yml`: initial local harness topology
- `butler/`: Butler backend and web UI
- `docs/evolution-and-technology-map.md`: origin, pivot, and technology choices
- `docker/butler/`: Butler image, startup script, and auth sync helpers
- `docker/butler-gateway/`: host-facing reverse proxy for the Butler UI
- `docker/codex-box/`: Codex box image, startup script, and health check
- `docker/egress/`: allowlisted proxy config for outbound traffic
- `docker/runtime-broker/`: narrow service that can start and stop disposable preview containers
- `docker/preview-egress/`: broader but still allowlisted egress path for preview runtimes
- `config/service-templates.json`: built-in service template catalog for common local dependencies
- `state/`: local runtime state mounts for the harness

## Butler First Cut

Butler now runs as a real service instead of a placeholder.

- Butler exposes a web UI on `http://127.0.0.1:8180`
- the UI includes a dedicated Codex terminal surface for direct shell access when needed
- the UI uses one unified Butler chat plus a jobs sidebar and window strip
- Butler mirrors Codex threads over app-server notifications and only reads full thread history when a window is opened
- Codex event notifications remain the primary supervision signal path, and Codex can also submit worker-authored supervisor reports through `manor-harness report`
- Butler has its own persisted auth and Pi session state
- Butler can seed its own auth from the existing shared Codex ChatGPT login without modifying the shared Codex auth data

### Butler Tool Contracts

Butler tool behavior is discoverable in code, not in the UI.

- the backend keeps one tool catalog that names every built-in Butler action
- each action declares its intended UI side effects like opening a window, removing threads, or returning focus to Butler
- the live Butler snapshot includes that tool metadata for agent-side inspection
- tool execution results also carry the declared UI effects so follow-on orchestration can react consistently

### First-Time Setup

Butler now exposes a first-time setup checklist in the Butler tab until the basics are ready:

- Butler auth is checked live and accepts either ChatGPT auth or API-key auth
- Codex auth is checked live and accepts either ChatGPT auth or API-key auth
- GitHub auth is checked from the Codex box because Codex owns repo cloning and fresh project creation
- the checklist lives outside the Butler chat and the terminal is available as a separate Codex shell surface

The exact operator commands used by that checklist are:

- `docker exec -it manor-butler butler-auth device`
- `docker exec manor-butler butler-auth api-key`
- `docker exec -it manor-codex-box codex-auth device`
- `docker exec manor-codex-box codex-auth api-key`
- `docker exec -it manor-codex-box gh-auth-headless`
- `docker exec manor-codex-box gh auth status`

### Butler Auth

Butler supports the same two operator-facing auth paths as the Codex box:

- ChatGPT auth through cached device-code login state
- API key auth through `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`

The Butler image includes the same Codex CLI auth helper pattern:

- `docker compose exec butler butler-auth status`
- `docker compose exec butler butler-auth device`
- `docker compose exec butler butler-auth api-key`

### Butler Networking

- Butler reaches Codex over the internal control network
- Butler UI is published through a tiny `nginx` gateway service so Butler itself does not need host port publishing
- the gateway is the only Butler-adjacent service directly exposed on the host
- Butler also proxies preview leases through stable Manor routes instead of exposing raw app ports directly

## Parallel Repo Work

Parallel work is allowed, but the unit of isolation is not just the branch.

The intended model is:

- one Butler-managed job gets one Codex thread
- one repo task gets one dedicated `butler/` branch
- parallel work in the same repo should use separate git worktrees
- one running app preview gets one disposable runtime and one preview lease

That means the practical rule is:

- `one job -> one worktree -> one isolated runtime -> one preview lease`

This keeps parallel work practical without turning the host into a port-collision mess.

### Preview and Port Strategy

- preview traffic stays on the private work network by default
- Butler creates and tracks preview leases
- Manor exposes previews through stable routes like `/preview/<lease-id>/`
- direct host port publishing should be the exception, not the default
- cleanup should stop the disposable runtime and release the lease deterministically

## Codex Box Startup

The Codex box now boots in app-server mode so Butler can supervise it over the control network.

- `codex-box` installs the official `@openai/codex` CLI in its image build.
- `codex-box` also installs `ttyd` and serves a direct shell from the same container
- the Codex shell is bootstrapped with `zsh`, Oh My Zsh, autosuggestions, syntax highlighting, and a fixed `manor-codex` host identity
- the container starts `codex app-server` on `ws://0.0.0.0:8080`
- the container starts `ttyd` on port `7681` and Butler proxies it at `/terminal/`
- Butler targets that endpoint through `ws://codex-box:8080`
- Codex state is mounted at `./state/codex-home` inside the stack
- Codex outbound traffic is forced through the egress proxy on the work network
- WebSocket auth flags can be passed through the container environment when Butler is ready to enforce them

## Egress Policy

The current egress path is fail-closed at the container-network level.

- `codex-box` is not attached to the internet network
- `egress` is the only service with external network reachability for Codex-bound traffic
- Codex uses proxy environment variables that point at `egress:3128`
- the proxy only allows `openai.com`, `*.openai.com`, `chatgpt.com`, `*.chatgpt.com`, `github.com`, `*.github.com`, `api.github.com`, and `*.githubusercontent.com`
- all other outbound destinations are denied

### Preview Runtime Egress

Preview runtimes use named egress profiles that are separate from the Codex box.

- Codex and Butler keep the tighter default egress policy
- preview runtimes use `none` by default, which means no preview-specific outbound proxy is attached
- non-default preview access is granted through named profiles that map to explicit allowlists in the preview egress config
- Butler can also supply a one-off domain allowlist at preview start time when one job needs a custom egress shape
- custom preview allowlists are materialized as temporary lease-scoped proxy listeners and are deleted with the preview lease
- the policy data lives outside Butler orchestration so operators can add, remove, or tighten profiles without changing the lease model
- preview readiness is heartbeat-gated by default, using `http` on `/`
- `heartbeat=none` is still available as an explicit override for special cases, but it is less trustworthy and should not be the normal preview path
- preview runtimes still stay on the private work network and reach the internet through an explicit proxy path

## Built-In Service Templates

Butler can now provision common local dependencies through built-in templates instead of relying on ad hoc setup notes.

The first built-ins are:

- Postgres
- Redis
- MySQL
- MSSQL
- SQLite

The intended usage is:

- Butler chooses a template
- Butler starts a disposable service lease for the current job or project
- the resulting host, port, and connection URI become discoverable to Butler
- Codex uses that service from the same private work network

SQLite is handled differently from the networked services:

- it is not started as a container
- Butler creates the database file directly in the target worktree
- the discovered connection URI points at that file path

### Extending Service Templates

Service templates are defined in `config/service-templates.json`.

To add another template:

- add a new entry to the template catalog
- choose `container` when the dependency should run as a disposable container
- choose `embedded` when the dependency is just a file provisioned inside the worktree
- define the default image, port, env defaults, and connection URI template

The broker stays generic:

- Butler owns the template catalog
- the runtime broker only starts and stops the resulting runtime
- this keeps the orchestration logic and the service catalog separate

### Auth Bootstrap

The Codex CLI needs credentials inside the container home before Butler can drive real work.

- API key auth is the default headless-friendly path for this stack
- when an API key is present in the container environment, startup bootstraps `codex login --with-api-key` automatically
- existing cached ChatGPT credentials in the mounted Codex home are preserved instead of being overwritten
- device-code auth is also available for headless ChatGPT sign-in through the bundled `codex-auth device` helper
- the official Codex docs describe copying `~/.codex/auth.json` into a Docker container for headless use when you want ChatGPT auth without device code

### Auth Controls

- `CODEX_AUTH_BOOTSTRAP=auto` logs in with an API key only when one is available and Codex is not already logged in
- `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE` supplies the API key source
- `CODEX_FORCED_LOGIN_METHOD=api` restricts the worker to API key auth
- `CODEX_FORCED_LOGIN_METHOD=chatgpt` restricts the worker to ChatGPT auth, including device-code login

## Next Steps

- deepen Butler job lifecycle management with leases, retries, and completion enforcement
- add first-class preview controls in the UI
- wire browser verification against the same leased preview routes
- add richer per-project orchestration and cleanup policies
