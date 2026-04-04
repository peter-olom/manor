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
- Codex has no direct internet path by default.
- Web and research work go through sidecars.
- Egress is explicit and inspectable.
- The system is a trusted personal worker appliance, not a multi-tenant secure sandbox.

## Repo Layout

- `compose.yml`: initial local harness topology
- `docs/evolution-and-technology-map.md`: origin, pivot, and technology choices
- `state/`: local runtime state mounts for the harness

## Next Steps

- replace placeholder service commands with real Butler and Codex startup commands
- define the Butler to Codex supervision protocol
- wire repository mounts and per-repo runtime contracts
- add structured logs, health checks, and recordings
- define the first egress policy contract
