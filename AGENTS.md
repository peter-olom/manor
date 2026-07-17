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
