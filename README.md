# Manor

Manor is a Docker-first personal agent workspace built to get real work done end to end.

Manor optimizes for ease of use and functionality. Butler and Workers get enough freedom to investigate, build, test, browse, and finish work with very little hand-holding.

The base appliance includes practical controls at known boundaries. Operators can layer on stricter network, secret, host, and runtime controls for their own risk model. Manor is open source so operators can inspect the tradeoffs, adapt the appliance, and connect it to infrastructure they already trust.

Butler handles supervision, provider-backed Workers handle execution, and Content Admission Review checks bounded representations of standard external content. Jobs can also use private previews, disposable services, and stack-scoped runtime state without exposing raw app ports on the host.

## Contents

- [Public Preview](#public-preview)
- [Screenshot](#screenshot)
- [Opinionated by Design](#opinionated-by-design)
- [Quick Start](#quick-start)
- [Source Distribution](#source-distribution)
- [Core Model](#core-model)
- [Execution Rule](#execution-rule)
- [Content Admission Review](#content-admission-review)
- [Async Verification Model](#async-verification-model)
- [Runtime Surfaces](#runtime-surfaces)
- [Auth](#auth)
- [Trust and Security Model](#trust-and-security-model)
- [Worker Configuration](#worker-configuration)
- [Development](#development)
- [License](#license)

## Public Preview

Manor is usable, but early. Expect rough edges around setup, upgrades, and advanced runtime workflows.

The current goal is a dependable single-operator appliance: clear Docker setup, honest trust boundaries, durable Worker state, and enough freedom for agents to finish useful work without constant supervision.

## Screenshot

Butler supervises the task on the left while the active Worker and its verification evidence remain visible on the right.

[![Manor Butler and Worker workspace](docs/assets/readme/manor-workspace.png)](docs/assets/readme/manor-workspace.png)

## Opinionated by Design

Manor's patterns are heavily shaped by my operating opinions.

The project optimizes for a specific way of working:

- Docker-first development and verification
- one trusted operator, not a hosted multi-tenant product
- warm long-running agents instead of throwaway prompt sessions
- explicit supervision through Butler
- a normal Worker environment for repository work, installs, builds, tests, and scripts
- disposable previews when clean runtime state, live services, or proof are useful
- evidence over status-only reporting
- private ingress and narrow host exposure
- simple primitives before broad orchestration layers

That bias is intentional. Manor is not trying to be neutral infrastructure for every team shape, but with it you can build and run most things.

## Quick Start

Prerequisites:

- Docker with Compose support
- at least one supported Worker provider: OpenAI/Codex, Ollama Local, Ollama Cloud, or OpenCode Go
- GitHub auth in the Worker host when that Worker needs repo cloning or fresh project setup

Run the guided installer:

```bash
./manor-start install
```

The installer checks Docker and Compose, validates configuration before replacing the local settings file, generates local control tokens, builds Manor from the current checkout, and waits for the stack to become healthy. Source builds are the supported lifecycle path so Manor can restart directly from its own working tree, including uncommitted experiments.

For the default non-interactive setup:

```bash
./manor-start install -y
```

Then open:

- `http://127.0.0.1:8180`

Daily control:

```bash
./manor-start
./manor-start stop
./manor-start status
./manor-start logs
```

`manor-start` is the canonical launcher. Before every command it checks for an executable, gitignored `manor-start.local`. Use that file for machine-specific environment or secret-manager injection without committing private configuration:

```bash
cp manor-start.local.example manor-start.local
chmod +x manor-start.local
```

The local launcher should finish by calling `manor-start` again. The included example uses the recursion-safe bypass automatically.

Self-improvement also uses the active checkout. Manor leaves changes uncommitted, rebuilds directly from the working tree when a restart is authorized, and never resets or cleans user files. If the changed source cannot start, the host controller rebuilds clean `HEAD` and brings Manor back while leaving the experiment in place for troubleshooting.

Restart the current stack through the host controller:

```bash
./update.sh
```

Update the current source branch before rebuilding and restarting:

```bash
./update.sh --latest
```

Interactive defaults:

- host port: `8180`
- start Manor after install: yes

## What Ships Today

Manor runs as one Docker Compose project with these services:

- `butler`: the always-on supervisor and web app
- `butler-gateway`: the host-facing reverse proxy for the Butler UI
- `worker`: the Pi RPC Worker host
- `runtime-broker`: the Docker control plane for previews, stack leases, and disposable services
- `host-controller`: the narrow restart/update sidecar that survives Manor appliance restarts
- `egress`: the outbound proxy for Butler and Worker execution, with Internet and restricted modes
- `preview-egress`: the separate outbound path for preview runtimes
- `playwright`: the browser automation sidecar
- `desktop-proof`: optional headed desktop proof sidecar for Electron/native app smoke checks

## Source Distribution

Manor is distributed as source. Clone or pull the repository, then use the official launcher to build the local container images from the active checkout:

```bash
./manor-start
```

## Core Model

The working model is:

- one operator
- one Butler supervisor
- one active Worker per Butler pair
- one selected provider, model, and reasoning option for that Worker
- one Docker host
- many jobs

Worker names the product role across model providers and CLIs. Manor runs every Worker through Pi RPC. OpenAI/Codex, Ollama Local, Ollama Cloud, and OpenCode Go supply the models and provider-specific authentication while Pi owns the session and transport behavior.

The default job shape is:

- one job maps to one provider-backed Worker session
- one repo task should use one dedicated worktree
- one job may own one isolated stack lease
- sticky stack and preview leases can be reused by later jobs when warm runtime state is intentional
- previews and disposable services attach to that stack when needed

Switching an active Worker to another provider or model starts a cold handoff. Manor carries forward the task, workspace, acceptance state, proof context, and lineage. Provider caches and hidden reasoning state do not transfer.

## Execution Rule

The Worker is a normal unprivileged development environment.

- use the active Worker for repository work, installs, builds, tests, scripts, and Git
- use snapshot previews when a clean runtime, isolated service, or disposable smoke run is useful
- use browser sessions when rendered UI behavior or durable browser proof matters
- use sticky stack or preview leases when the operator wants a warm reusable runtime across jobs
- use the optional desktop proof sidecar only when native headed app verification is needed

### Installing Worker CLIs

Standalone CLIs can be installed from the Worker CLI when their installer supports an unprivileged destination under `~/.local`. Manor keeps `~/.local` and `~/.config` on persistent Worker volumes, so the executable and its user configuration survive normal restarts and container recreation. Removing those volumes also removes the installed tools and configuration.

Worker outbound HTTP and HTTPS defaults to the Internet through Manor's proxy. The proxy blocks private and internal destinations. Switch to **Restricted** under **Settings → Security → Runtime egress** when you want built-in and operator-approved hosts only. New proxy requests use changes immediately; existing connections may stay open.

Tools that require `apt`, root access, system-wide paths, or additional operating-system libraries must use the Power User workflow: bake them into the Worker image and rebuild Manor. A user-space CLI that depends on a missing system library belongs in that image as well. This keeps the system layer reproducible while allowing self-contained CLIs to be installed when needed.

## Shared Skills

Butler and Worker load appliance-wide user skills from one shared registry. Butler publishes to it through Manor's validated skill workflow. Butler's command executor and every Worker mount the published registry read-only, so neither agent can bypass publication by changing installed files directly. Repository-local skills remain ordinary repository files.

For a repository-backed skill, Butler performs the installation work itself:

- clone through the standard CAR-aware Git path into writable Butler scratch
- inspect the repository and choose the required build or installation commands
- run the skill's real verification or doctor command
- ask the operator to approve the exact prepared files
- publish the validated package to the shared registry
- start a fresh Worker session to load and independently exercise the installed skill

The source repository is not pinned or replaced with a digest-addressed checkout. The approval records a hash of the exact prepared package so the files approved by the operator are the files Manor publishes.

Butler's executor uses the Worker toolchain as an unprivileged account. It can write only its scratch volume. Repositories and installed skills are read-only there. Worker keeps normal write access to repositories and supplies the final execution proof. Existing Butler and Worker user skills are copied into the shared registry on upgrade when their names do not conflict; the old volumes remain intact.

## Content Admission Review

Content Admission Review, or CAR, reviews a bounded representation at the main routes where external instructions enter Manor:

- standard repository clone and update operations
- provider-backed web search and fetch results
- browser page content and action output

The reviewer gets one defensive job. It treats the content supplied to it as suspicious data, has no web tools, and returns a strict `clear`, `suspicious`, or `hostile` verdict. It does not share the active agent's conversation or follow instructions found in the content.

CAR reviews content by source and content identity. The same content reuses its cached verdict. Manor does not persist the full reviewed payload. The cache keeps the digest, verdict, confidence, bounded evidence excerpts, explanation, safe summary, and review time.

The operator chooses the behavior and reviewer model under **Settings → Security**. The model picker can pin CAR to one authenticated model. Automatic selection uses the first authenticated background model available.

- **Review** warns on suspicious or hostile content and keeps work moving. If the reviewer is unavailable, Manor says so and continues.
- **Enforce** withholds hostile web and browser content. Hostile repository operations fail after review, and their imported files remain on disk for inspection or removal. An unavailable reviewer blocks admission.
- **Off** passes content through without CAR.

Review is the default. CAR runs automatically during interactive work and automations, including jobs that start at odd hours. It does not pause for confirmation.

CAR is separate from Butler's acceptance and adversarial reviews. CAR looks for hostile incoming instructions. Butler's other reviews decide whether completed work is correct, well evidenced, and ready to accept.

CAR covers Manor's standard ingress paths. A Worker can still use another network client, package installer, or custom tool that CAR does not see. Restricted runtime egress and operator-owned infrastructure controls remain the stronger boundary when that matters.

Runtime egress is a separate control. It applies to outbound HTTP and HTTPS sent through the shared Butler and Worker proxy. Worker has no direct public network, so software that ignores the proxy normally fails. The control does not cover preview runtimes, Playwright browser or desktop-proof sessions, Docker or Ollama image pulls, host traffic, or named Manor services on the proxy bypass list. Butler is connected to a public network, so Butler software that ignores the proxy can bypass this setting. Preview runtimes use their own egress profile.

## Async Verification Model

Manor is built for async work. The operator should be able to state intent, step back, and get a reviewed outcome instead of supervising every command.

This review model checks the quality and completeness of work after execution. It does a different job from CAR.

For delegated implementation, investigation, debugging, UI, API, deploy, and verification work, Butler now turns the request into an internal execution contract:

- an inferred work standard, kept out of the UI
- a task category, such as UI, API, deploy, docs, data, writing, or generic code
- a verification matrix mapped to the acceptance points
- expected evidence for each row
- Butler-owned acceptance after the worker reports back

The Worker submits evidence. Butler accepts, rejects, or waives it.

Weak reports are expected to be pushed back privately. UI work needs screenshot or video proof plus responsive, accessibility, and taste review. API work needs request-level smoke evidence, failure-path evidence, and log or runtime review. Final operator closeout should read like a compact proof dossier: what changed, what Butler accepted, what proof was reviewed, and what risk remains.

The operator should see better outcomes and better proof. They should not have to pick a depth setting or read the whole worker transcript to trust the result.

## Runtime Surfaces

### Butler

Butler is the operator-facing control plane.

Today it provides:

- a web UI on `http://127.0.0.1:8180`
- a unified Butler chat
- a jobs sidebar and per-job windows
- a Worker workstream with one operational Worker CLI
- runtime visibility for stacks, previews, and services
- image-reference tracking for visual tasks
- tool-driven delegation into provider-backed Worker jobs

Butler is built on the Pi agent framework. Its supervisor stays in the Butler environment, while every provider-backed Worker session runs through Pi RPC in the separate Worker environment.

### Worker Runtime

Workers share one Pi-backed supervision and runtime contract across providers.

The Worker environment provides:

- the Pi RPC Worker runtime
- one direct Worker CLI through `ttyd`
- repo and worktree access through a dedicated Docker volume mounted at `/repos`
- shared runtime state through dedicated Docker volumes
- local helper access through `manor-harness`
- read-only access to the appliance-wide shared skill registry

The Pi RPC harness provides Worker sessions for Manor's supported OpenAI/Codex, Ollama Local, Ollama Cloud, and OpenCode Go providers. These sessions execute in the Worker environment and receive the same job payload, workspace access, harness capabilities, reporting contract, and Butler review.

The `worker` service runs in the `manor-worker` container. Its runtime identity is `worker@manor-worker`, and it hosts the complete Worker environment. The UI exposes exactly two agent CLIs: Butler CLI and Worker CLI.

Workers own repository changes. Butler can inspect repositories read-only, prepare and publish shared skills from isolated scratch, and manage runtime lifecycle and policy.

### Previews

Preview runtimes are disposable containers started by the runtime broker.

Current preview behavior:

- every preview gets a lease
- sticky preview leases can stay warm for later jobs
- Butler exposes a stable private route for each lease
- previews are gateway-only and do not publish raw host ports
- previews are heartbeat-gated during startup
- preview egress defaults to normal outbound internet access
- previews are available for clean installs, disposable builds, app startup, and runtime verification
- `none`, named profiles, and custom domain policies remain available when a preview needs stricter outbound control

### Stacks

Stacks are the unit of multi-container runtime isolation.

Each stack gives a job:

- one private Docker network
- grouped lifecycle for previews and disposable services
- stack-level cleanup
- optional sticky retention for reuse by later jobs
- optional retained volumes for stateful work

This is the path Manor uses for Docker-heavy projects that need multiple cooperating app and infra containers.

### Stateful Services

Stateful stacks are the default answer for mutable service state.

`manor-harness stack start --stateful` creates a job-scoped retained storage namespace and applies an opinionated policy:

- a project base storage key is derived automatically
- a writable per-job storage key is derived automatically
- the job stack forks from the project base by default
- built-in stateful services copy data lazily on first use
- `manor-harness stack promote <stackId>` publishes back to the project base by default

`--storage-mode base` is reserved for intentional seed or snapshot refresh work.

The intended rule is simple:

- never let concurrent jobs share one writable database volume
- fork for job work
- promote only after validation

Built-in dependency templates:

- Postgres
- Redis
- MySQL
- MSSQL
- RabbitMQ
- MinIO
- Mailpit
- SQLite

Container-backed templates run as disposable private-network services. SQLite is provisioned directly in the selected worktree as an embedded file.

If a dependency is missing, Butler or a Worker can register a new template on first use and persist it for later jobs.

### Headed Desktop Proof

Electron and native desktop checks use a separate opt-in sidecar instead of the browser automation sidecar.

Start it only when needed:

```bash
./manor-start desktop start
```

Daily desktop proof control:

```bash
./manor-start desktop start
./manor-start desktop stop
./manor-start desktop status
```

The sidecar runs a virtual display, window manager, x11vnc, noVNC, screenshot capture, simple desktop input tooling, and a persistent desktop home under the sidecar state volume. Browser proof remains on the lighter Playwright sidecar.

### Worker Harness

Workers interact with attached runtimes through `manor-harness`.

That surface currently supports:

- job context and runtime inventory
- stack start, inspect, lease update, promote, and stop
- preview start, inspect, lease update, logs, processes, exec, verify, and stop
- desktop status, list, start, current-screen, action, and stop
- service template listing and registration
- service start, inspect, logs, processes, exec, and stop
- supervisor reporting back to Butler with point-specific evidence

The important constraint is unchanged:

- workers use `manor-harness`
- Butler and the broker own runtime policy

## Auth

OpenAI Workers use Pi's OpenAI provider authentication. Butler supports ChatGPT device-code login and OpenAI API-key login, then makes that credential source available to the Worker runtime.

Ollama Local does not need external provider credentials. Ollama Cloud and OpenCode Go use their provider API keys. Configure and validate every enabled provider in Settings before assigning it Worker jobs.

Useful commands:

```bash
docker compose exec butler butler-auth status
docker compose exec butler butler-auth device
docker compose exec butler butler-auth api-key

docker compose exec worker gh auth status
docker compose exec -it worker gh-auth-headless
```

## Trust and Security Model

Manor is a trusted personal worker appliance, not a multi-tenant sandbox.

Current trust boundaries:

- Butler and the Worker host are separate services
- Butler contains only its own Pi-backed supervisor agent
- Pi RPC Worker sessions execute in the Worker host
- Worker execution reaches the Internet through Manor's proxy rather than a separate unmonitored route
- Content Admission Review checks bounded representations from standard repository, web, and browser ingress; unchanged content reuses a hash-based verdict cache
- outbound HTTP and HTTPS from Butler and Worker clients that honor Manor's configured proxy goes through `egress`; Internet is the default and Restricted allowlisting is optional, while the proxy blocks private destinations
- operators can add or remove trusted proxy hostnames in Settings → Security → Runtime egress; the allowlist applies only in Restricted mode and built-in domains remain read-only
- user-installed Worker CLIs persist in the Worker tools volume and remain unprivileged
- preview runtimes keep private runtime networking and get direct outbound internet by default
- optional preview egress profiles remain available for stricter outbound control
- the runtime broker talks to the Docker socket for scoped preview, stack, service, browser, and proof capabilities
- the host controller talks to the Docker socket only for the fixed Manor restart/update capability
- the host controller uses its own token, separate from the runtime broker token
- preview and service traffic stays on private Docker networks
- Butler routes previews instead of publishing arbitrary app ports on the host

This is an architecture-first containment model, not a claim of full internal sandboxing.

Content Admission Review is a high-value prompt-injection screen with a bounded job. Repository review uses a bounded snapshot of selected commit objects, filenames, instruction-bearing files, and instruction-like matches. Web and browser inputs are bounded before review as well. Arbitrary network clients, package installers, host-mounted changes, absolute binary paths, and content outside those representations can bypass CAR. In Enforce mode, hostile web and browser content is withheld; a hostile repository import fails after review, and its files remain on disk for inspection or removal. Operators who need stronger guarantees should add their own infrastructure controls and use Restricted runtime egress where its proxy boundary applies.

For vulnerability reporting and remote-use hardening, see the [security policy](SECURITY.md).

## Worker Configuration

Butler builds the shared delegation, runtime, proof, and reporting instructions for every Worker. Provider availability, model discovery, and reasoning options come through Pi and the selected provider's discovery and transform rules.

## Development

Current local development assumptions:

- the default stack is deployment-safe and persists core state in named Docker volumes
- the official launcher builds local images and mounts the active checkout into the relevant execution services
- an executable `manor-start.local` is always consulted first for machine-local environment injection
- Butler source hot reload is opt-in through the development overlay
- local hot reload runs use `./manor-start start --dev`
- older host-side `state`, `artifacts`, and `repos` directories are not mounted by default anymore
- runtime broker operations affect live Docker resources on the host

For contribution workflow and validation expectations, see the [contributing guide](CONTRIBUTING.md).

## Repo Layout

- `compose.yml`: deployment-safe Manor stack with named Docker volumes
- `compose.build.yml`: source-build overlay used by the official launcher
- `compose.dev.yml`: optional local Butler hot-reload overlay
- `butler/`: Butler backend and web app
- `config/`: optional preview egress profiles
- `docker/butler/`: Butler image and auth helpers
- `docker/butler-gateway/`: Butler reverse proxy
- `docker/worker/`: image for the Pi RPC Worker and Worker CLI
- `docker/egress/`: outbound proxy with Internet and restricted modes
- `docker/host-controller/`: restart/update controller with its own scoped token
- `docker/preview-egress/`: optional restrictive preview egress control plane
- `docker/runtime-broker/`: preview, service, and stack runtime broker
- `docker/playwright/`: browser automation image
- `docker/desktop-proof/`: optional headed desktop proof image

## Verification Status

The current stack has been verified recently for:

- Butler production build success
- live stack lease lifecycle
- live disposable service provisioning
- retained volume restart persistence
- retained volume fork and promote flow for Postgres
- cleanup back to zero active stacks and services after smoke runs

## License

Manor is licensed under the MIT License.
