# Manor Evolution and Technology Map

## Why This Exists

The original direction was to build a security mediation layer around a powerful agent runtime.

That evolved into a clearer thesis:

- the highest-value component is not another sandbox runtime,
- the highest-value component is an always-on personal agent harness that can supervise real coding work over time.

This project is the result of that pivot.

## Evolution

### Phase 1: Security Envelope Around OpenClaw

Initial thinking centered on building a mediation layer around an autonomous runtime:

- command mediation,
- network mediation,
- approvals,
- DLP,
- audit trails,
- safe host and container control.

That work clarified the threat model, but it also exposed a strategic issue:

- building low-level security infrastructure from scratch is expensive,
- it is not the main source of user value for a personal coding and operations agent.

### Phase 2: Compare Against Better Runtime Substrates

The architecture was compared against:

- NemoClaw and OpenShell for safer lower-level runtime control,
- Codex as the higher-value coding engine,
- Daytona and similar sandbox products for disposable execution,
- managed and open browser tooling for web interaction.

That comparison led to a pivot:

- Codex is the best primary worker for the actual work,
- disposable sandboxes are useful as a containment layer,
- browser automation should be a separate capability,
- the product should center on supervision and orchestration.

### Phase 3: The Manor Model

The system is now modeled as:

- one brain,
- multiple execution lanes,
- one supervisor,
- one policy envelope.

In plain terms:

- Codex thinks and executes,
- Butler governs and monitors,
- trusted work stays on a warm worker,
- lower-trust work goes to sidecars or disposable backends.

## Current Product Thesis

Manor is a personal agent appliance for one operator.

It should:

- remain always on,
- manage long-running Codex work,
- expose thread state to a custom client,
- let the operator inspect previews and recordings over Twingate,
- handle many repositories,
- supervise task completion with minimal human interruption.

## Technology Map

### Core Control Plane

- `Butler`
  - built on the Pi agent framework
  - always-on supervisor
  - heartbeat and liveness tracking
  - run queue, leases, retries, and completion checks
  - hook target for Codex completion signals
  - operator intent enforcement

- `Codex Box`
  - primary coding worker
  - owns repositories and local tools
  - can run broad coding and project work
  - should avoid direct internet access when sidecars can do the job instead

### Browser and Web Layer

- `Playwright`
  - fully open browser automation option
  - recordings, screenshots, previews, and flow verification

- `Kernel`
  - managed browser automation option when convenience matters more than cost

### Disposable Execution Layer

- `E2B`
  - open execution sandbox option

- `Daytona`
  - managed execution sandbox option when convenience matters more than cost

These are not the center of the system.
They are execution backends for lower-trust or disposable work.

### Internet and Research Layer

- dedicated egress or research service
  - dependency installs
  - external documentation fetches
  - package registry access
  - controlled web retrieval

The main Codex worker should not browse the raw internet directly by default.

### Access Layer

- `Twingate`
  - private operator access
  - local previews
  - browser recordings
  - service dashboards

## Trust Model

Manor is not trying to create strong internal isolation between Butler and Codex inside one trust zone.

Instead, it uses these boundaries:

- Butler is separate from Codex at the service level
- internet-facing work is separate from the Codex box
- disposable runtimes can be used for lower-trust work
- the host and private network remain outside the default worker blast radius

## Prompt Injection Position

Prompt injection is treated as an action authorization problem, not just a text filtering problem.

The practical approach is:

- reduce direct raw web exposure for the Codex box
- route web and research activity through sidecars
- keep egress explicit
- keep the worker powerful but avoid feeding it arbitrary hostile inputs unnecessarily

## Butler Implementation Direction

Butler is intended to be implemented on top of the Pi agent framework.

That is important because Butler is not just a thin process manager. It is meant to behave like an always-on operational agent that can:

- keep a heartbeat,
- supervise long-running Codex work,
- react to hooks when Codex finishes,
- inspect whether work actually met the requested objective,
- and push Codex to continue when the result is incomplete.

Pi is the planned foundation for that behavior.

## Exfiltration Position

The main exfil risk is handled with architecture, not wishful prompting:

- direct internet off on the main worker when possible
- outbound traffic centralized in a dedicated egress service
- package and research access separated from the main worker
- logs and recordings retained for operator review

## Open Questions

- what exact process should Butler use to decide that a Codex run is incomplete
- whether Butler should talk to Codex only through hooks, or also poll a run registry
- when to route work to disposable sandboxes instead of the warm worker
- whether dependency installation should happen as a controlled egress action or in a separate build lane
- how much browser context should be returned to Codex versus kept as operator-only evidence

## Decision Summary

Current default stack:

- `Manor` as the full harness
- `Butler` as supervisor
- `Codex Box` as trusted worker
- `Playwright` as the open browser option
- dedicated `Egress` sidecar for outbound work

Optional convenience upgrades:

- `Daytona` for execution
- `Kernel` for browser automation

Optional open execution backend:

- `E2B`
