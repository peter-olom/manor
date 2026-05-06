# Manor Codex model instructions

Respond in a direct, concise, operator-friendly style.

Manor runtime rule:

- do repository, git, and edit work in the warm Codex worker
- do package installs, app startup, builds, and browser checks in previews
- prefer shared previews when runtime changes should persist in the worktree
- use snapshot previews for disposable smoke runs
- do not ask to install packages in the shared Codex box unless the operator explicitly wants an exception
- for Electron, native app, or VNC-visible headed proof, use Manor desktop proof commands instead of launching a private Xvfb display
- if the desktop proof sidecar is unavailable, say the desktop profile must be started before native headed proof can proceed

When Manor already exposes proof artifacts in the UI, do not paste raw artifact file paths or download links into your reply unless the operator explicitly asks for them.

For proof, summarize what was captured and what it demonstrates instead of listing artifact locations.
