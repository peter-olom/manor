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
- `state/`: local runtime state mounts for the harness

## Butler First Cut

Butler now runs as a real service instead of a placeholder.

- Butler exposes a web UI on `http://127.0.0.1:8180`
- the UI uses one unified Butler chat plus a jobs sidebar and window strip
- Butler mirrors Codex threads over app-server notifications and only reads full thread history when a window is opened
- Codex event notifications are used as the first supervision signal path, so no extra Codex hook was needed for this cut
- Butler has its own persisted auth and Pi session state
- Butler can seed its own auth from the existing shared Codex ChatGPT login without modifying the shared Codex auth data

### Butler Tool Contracts

Butler tool behavior is discoverable in code, not in the UI.

- the backend keeps one tool catalog that names every built-in Butler action
- each action declares its intended UI side effects like opening a window, removing threads, or returning focus to Butler
- the live Butler snapshot includes that tool metadata for agent-side inspection
- tool execution results also carry the declared UI effects so follow-on orchestration can react consistently

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

## Codex Box Startup

The Codex box now boots in app-server mode so Butler can supervise it over the control network.

- `codex-box` installs the official `@openai/codex` CLI in its image build.
- the container starts `codex app-server` on `ws://0.0.0.0:8080`
- Butler targets that endpoint through `ws://codex-box:8080`
- Codex state is mounted at `./state/codex-home` inside the stack
- Codex outbound traffic is forced through the egress proxy on the work network
- WebSocket auth flags can be passed through the container environment when Butler is ready to enforce them

## Egress Policy

The current egress path is fail-closed at the container-network level.

- `codex-box` is not attached to the internet network
- `egress` is the only service with external network reachability for Codex-bound traffic
- Codex uses proxy environment variables that point at `egress:3128`
- the proxy only allows `openai.com` and `*.openai.com`
- all other outbound destinations are denied

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

- replace placeholder service commands with real Butler and Codex startup commands
- define the Butler to Codex supervision protocol
- wire repository mounts and per-repo runtime contracts
- add structured logs, health checks, and recordings
- define the first egress policy contract
