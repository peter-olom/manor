## Local Development

- Use the Docker workflow by default.
- Use `./manor-start` for install and lifecycle commands. Do not use raw Compose for normal starts or restarts.
- Before starting or restarting Manor, check whether the gitignored `manor-start.local` exists and is executable. The official launcher runs it first so machine-local environment and secret injection are preserved.
- Keep machine-specific startup behavior in `manor-start.local`, based on `manor-start.local.example`. Never add secrets or personal environment values to the committed launcher.
- For Butler UI work, run `./manor-start start --dev` so the Butler container has source mounts, `BUTLER_HOT_RELOAD=1`, and Vite middleware enabled.
- Before relying on hot reload, confirm the running Butler container reports hot reload mode. If it is in static mode, run `./manor-start restart --dev`.
- On Docker Desktop, if UI edits do not appear, prefer enabling polling for the dev server watcher before doing a full image rebuild.
- Manor self-improvement uses the active checkout. Do not create a branch, worktree, or commit unless the operator explicitly asks.
- Leave experiments uncommitted. A source restart builds the working tree; if startup fails, Manor retries from clean `HEAD` without resetting or cleaning the user's files.

## Agent Judgment And Hard Boundaries

- Give Butler and Worker the goal, relevant context, live capabilities, constraints, and useful evidence. Let the agents choose and revise the execution path.
- Keep workflow prompts focused on outcomes. Prescribe an exact sequence only when the operator asked for that method or the sequence protects a real safety or integrity boundary.
- Use deterministic enforcement for authentication, permissions, Content Admission Review, operator approval, package integrity, ownership, concurrency, destructive actions, and proof binding.
- Treat a missing capability in one agent environment as a routing fact. Infer whether Butler should advise, prepare, inspect, or execute, and whether Worker should perform the environment-dependent work.
- Keep tool contracts goal-oriented where judgment helps. Return concrete runtime facts and results so the agent can adapt without encoding every reasonable branch in server code.
- Test outcomes and invariants. Allow multiple valid execution paths when the safety boundary and required evidence stay intact.
- Scope the Butler-Worker turn budget to one operator turn. Start a fresh allowance when each queued operator message begins. Count one turn only when Butler successfully dispatches Worker work that will enter adversarial review: `Butler -> Worker -> Review`. Rework dispatched after a rejection consumes the next turn. Worker tool calls and internal turns, review attempts or schema retries, callback registration, held context, and startup recovery do not consume turns.
- Treat the turn budget as an execution boundary. Autonomous supervision must not delete, detach, hand off, or replace a Worker to obtain a fresh allowance. A new operator turn resets usage, while the configured limit remains unchanged.
- Scope every terminal Butler reply to the latest operator message that caused the Worker dispatch. Carry Butler-side checks and the subsequent Worker report into review, lead with the direct answer, and do not recap accepted earlier work unless it is relevant. Automatically replace a completed review scope for new follow-up work; keep incomplete or rejected scope visible and governing until Butler explicitly replaces it.
- Ask the operator when a missing choice would materially change the result. Handle ordinary routing, command selection, retries, and verification choices through agent judgment.

## Butler Model Providers And Harnesses

- Treat Butler and Worker as the two agent environments. Butler contains Butler's Pi-backed supervisor agent. The `worker` service runs the Pi-backed Worker host. Its runtime account and hostname are `worker` and `manor-worker`.
- Keep the built-in CLI targets aligned with those environments: `Butler CLI` and `Worker CLI`. Do not expose Codex or Pi as top-level CLI environments.
- Use Pi as the only Butler and Worker harness. Route OpenAI Codex, Ollama Cloud, Ollama Local, and OpenCode Go sessions through Pi.
- Treat `openai-codex` as a Pi model provider. Keep its authentication and model inventory aligned with the installed Pi release.
- For OpenCode Go, use the live OpenCode Go model endpoint as the source of model availability. Use OpenCode's own provider transform rules as the source of thinking and variant behavior.
- Keep OpenCode Go thinking options derived, not hard-coded. For each served model, inspect OpenCode's current transform outcome in order: no variants means N/A, concrete variants become picker options, and provider-native variant names should be shown when they differ from generic effort labels.
- Treat model-family names as regression examples, not as a registry. Put current examples in tests when they document behavior, but make the implementation follow OpenCode transform parity instead of static allowlists that will age poorly.
- Do not show a thinking option unless the transport can send the corresponding upstream payload. MiniMax M3 requires OpenCode-style native `thinking` objects, so expose its variants only after the Pi route can send that native payload correctly.
- When syncing OpenCode Go behavior, inspect OpenCode's transform logic first. Preserve the order of special cases because earlier matches, such as MiniMax M3, intentionally override broader family rules.

## Content Admission And Runtime Security

- Treat Manor as a trusted personal appliance. Do not describe Butler, Worker, previews, or CAR as a complete sandbox or exfiltration boundary.
- Keep the Worker useful as a normal unprivileged development environment. Repository work, installs, builds, tests, scripts, Python, Node, and Git should run normally. Do not reintroduce broad command or package-manager guards.
- Keep Butler and Worker HTTP/S clients configured for Manor's proxy. Fresh installations default to Internet mode while the proxy blocks private and internal destinations. Preserve an existing Restricted policy during upgrades, and do not describe it as covering preview, browser, desktop-proof, host, image-pull, non-proxy, or direct Butler traffic.
- Keep Content Admission Review at the standard repository, web search/fetch, and browser ingress points. Add new external-content surfaces to CAR at their shared admission boundary instead of reviewing every downstream file read.
- Run CAR as an isolated defensive model task. Treat all supplied content as suspicious data, disable web tools, require the strict verdict schema, and never give the reviewer the active agent's conversation, memory, or tools.
- Cache CAR verdicts by source and content identity without persisting the full reviewed payload. Bounded evidence excerpts may quote source text, so keep the cache inside trusted appliance state. Do not repeat reviews or warnings for unchanged content during normal use.
- Keep the security modes explicit: Review warns and continues, Enforce blocks hostile web and browser delivery and fails hostile repository operations after review, and Off bypasses CAR.
- Keep Review as the default. CAR runs automatically for interactive work and automations and must not add an operator confirmation step.
- In Enforce mode, repository content may already be present on disk when the command fails. Keep that limitation visible in product copy and documentation.
- Keep CAR coverage claims bounded. Repository admission samples selected commit objects, filenames, instruction-bearing files, and instruction-like matches. Web and browser inputs also have size limits.
- Keep CAR separate from acceptance, adversarial, proof, and correctness reviews. CAR screens incoming content; the other reviews judge completed work.
- Preserve the remaining boundaries: non-root Worker, no Worker Docker socket, read-only inputs, authenticated broker and harness actions, private service networks, and no arbitrary host port publishing.
