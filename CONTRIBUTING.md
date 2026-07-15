# Contributing to Manor

Manor is in public preview. Contributions are welcome, but the project should stay small, explicit, and Docker-first.

## Before You Start

- Open an issue for large behavior changes before writing code.
- Keep pull requests focused on one problem.
- Prefer simple fixes over new abstractions.
- Do not add large dependencies unless the benefit is clear.
- Preserve the trusted personal appliance model unless the change is explicitly about that boundary.

## Development

Use Docker as the default runtime.

For the normal stack:

```bash
./manor-start
```

For local Butler hot reload:

```bash
./manor-start start --dev
```

Use the canonical launcher for lifecycle work so source builds, health checks, and any gitignored machine-local override are applied consistently.

When working through Manor itself, do package installs, app startup, builds, and browser checks inside previews. Keep repository edits in the active Worker.

Worker behavior must remain consistent across Manor's supported harnesses. OpenAI/Codex sessions run through the Codex app server. Ollama Local, Ollama Cloud, and OpenCode Go sessions run through Pi RPC. Keep provider discovery, authentication, reasoning transforms, and transport-specific behavior in their existing adapters. Shared Worker code should depend on normalized contracts.

## Validation

Run the focused checks that match your change. For Butler changes, run:

```bash
cd butler
npm test
npm run build
```

If your change touches runtime behavior, also verify the Docker stack, relevant logs, and the affected preview or service lifecycle.

If your change touches shared Worker behavior, validate every affected harness. Validate the Codex app-server and Pi RPC paths separately when the change affects both.

## Releases

Manor uses the version in `butler/package.json` as its canonical release version. Keep `butler/package-lock.json` in sync when changing it.

For a normal release, open the **Release** action in GitHub, choose **Run workflow**, and select a `patch`, `minor`, or `major` increment. The action updates both package files, validates the release, runs the test and build gates, commits the version, creates and pushes the matching tag, and publishes the GitHub release with generated notes.

To prepare a version manually:

```bash
cd butler
npm version --no-git-tag-version patch
npm run release:check
npm test
npm run build
```

Commit the version change, create the matching `vX.Y.Z` tag, and push the commit and tag. External matching tag pushes use the same validation, test, build, and publishing gates.

## Pull Requests

A good pull request includes:

- the problem being fixed
- the behavior change
- validation performed
- known limitations or follow-up work

Avoid unrelated formatting churn. Do not include local state, generated test artifacts, credentials, API keys, tokens, or personal workspace files.

## Project Direction

Manor is a trusted single-operator worker appliance. It is not trying to become a generic multi-tenant platform, a hosted sandbox product, or a heavy orchestration framework.
