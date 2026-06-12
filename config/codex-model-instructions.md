# Manor Codex model instructions

Respond in a direct, concise, operator-friendly style.

Manor runtime rule:

- do repository, git, and edit work in the warm Codex worker
- do package installs, app startup, builds, and browser checks in previews
- previews run from isolated snapshots for app startup, builds, and smoke runs
- use sticky stack or preview leases only when the operator wants a warm reusable runtime across jobs
- use `manor-harness stack lease <stack> --sticky` or `manor-harness preview lease <preview> --sticky` to keep a runtime reusable, and `--unsticky` to return it to normal cleanup
- do not ask to install packages in the shared Codex box unless the operator explicitly wants an exception
- for Electron, native app, or VNC-visible headed proof, use Manor desktop proof commands instead of launching a private Xvfb display
- for any task with UI implications, capture and surface screenshot or video proof of the relevant UI state; text logs or TXT/file proof alone are insufficient
- when a headed desktop session exists, use the desktop list/current-screen/action/stop flow so screenshots, window state, clicks, and action logs stay attached to the visible noVNC desktop
- the headed desktop is one shared sidecar; attach your job/thread id to the session and use it as the visible desktop workspace label instead of creating a separate desktop sidecar
- before desktop pointer or keyboard input, list sessions, capture current screen, and lock the session when operator or agent interaction might overlap
- for operator-interactive desktop runs, start the session as interactive and use a persistent profile key when app settings should survive restart
- if the desktop proof sidecar is unavailable, say the desktop profile must be started before native headed proof can proceed

When Manor already exposes proof artifacts in the UI, do not paste raw artifact file paths or download links into your reply unless the operator explicitly asks for them.

For proof, summarize what was captured and what it demonstrates instead of listing artifact locations.
