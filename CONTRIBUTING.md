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
docker compose up -d --build
```

For local Butler hot reload:

```bash
docker compose -f compose.yml -f compose.dev.yml up -d --build
```

When working through Manor itself, do package installs, app startup, builds, and browser checks inside previews. Keep repository edits in the Codex worker.

## Validation

Run the focused checks that match your change. For Butler changes, run:

```bash
cd butler
npm test
npm run build
```

If your change touches runtime behavior, also verify the Docker stack, relevant logs, and the affected preview or service lifecycle.

## Pull Requests

A good pull request includes:

- the problem being fixed
- the behavior change
- validation performed
- known limitations or follow-up work

Avoid unrelated formatting churn. Do not include local state, generated test artifacts, credentials, API keys, tokens, or personal workspace files.

## Project Direction

Manor is a trusted single-operator worker appliance. It is not trying to become a generic multi-tenant platform, a hosted sandbox product, or a heavy orchestration framework.
