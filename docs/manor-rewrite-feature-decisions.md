# Manor Pair Rewrite Feature Decisions

Date: 2026-06-21

> Historical design record. This document describes the Codex-only Worker model in use on the date above. Current Manor supports provider-backed Workers through Codex app server and Pi RPC. The terminology below is preserved so the original decisions remain readable in context.

## Docker Instance Review

I reviewed the running Docker Manor instance on `127.0.0.1:8180`. The live surface showed one global Butler chat, a long Codex thread drawer, dense job contracts/checklists, memory promotion events, proof dossiers, model/effort controls, scratch-pad driven async jobs, and old window-style thread switching. The page bootstrap also returned a very large global shell payload with historical thread summaries and open thread details, which explains degraded long-session responsiveness.

## Retained Or Reimagined

- Memory: retained as the unifying infrastructure. The rewrite records pair turns into the memory graph, saves pair summaries as Butler memory, and retrieves memory cards per Butler pair.
- Codex worker execution: retained as infrastructure, but reimagined as exactly one worker attached to one Butler pair instead of a free-floating thread list.
- Worker reports and callbacks: reimagined so reports sync back into the originating pair transcript. Manual revert also appends the worker result to that pair.
- Checklists/proofs/runtime details: retained as lower-level infrastructure. They are no longer first-screen global UI; worker detail is lazy-loaded only when the worker or split pane is active.
- Model effort: retained at handoff time. New worker spins default to `xhigh` because the user explicitly wanted stronger worker reasoning for deep tasks.
- Long-running session history: retained, but paged and virtualized. Pair summaries load first; selected pair history loads in pages; transcript DOM is windowed.

## Discarded

- Single global Butler chat: discarded because it mixed unrelated operator conversations, worker callbacks, and memory events into one overloaded stream.
- Window/tab style Codex thread switching: discarded from the primary UX because it made the worker relationship ambiguous. The new unit is Butler pair -> one Codex worker.
- Global thread drawer as the main navigation: discarded because historical thread volume dominated the UI. Pair summaries now drive navigation.
- Scratch pad as a separate first-class surface: discarded from the rewritten first screen. The same async idea is represented by creating a Butler pair and attaching a worker.
- Terminal tabs in the primary UI: discarded from the rewritten first screen because they are operational escape hatches, not the core Butler/worker workflow.
- Global clear chat/delete-from controls: discarded because pair deletion and paged history make cleanup local to the pair.
- Always-visible full proof dossier/checklist blocks: discarded from the default chat lane because they overwhelm the conversation. Evidence remains available through worker detail and existing artifact routes.
- Preview annotation companion in the primary UI: discarded from the first pass. It is useful proof infrastructure, but not essential to the pair conversation model.

## New UX Contract

- Clicking New creates a new isolated Butler chat.
- Each Butler chat can attach only one Codex worker; attempting a second worker returns `409`.
- Butler and worker lanes can be viewed independently or as split view with Butler left and Codex right.
- Worker handoff prompts are generated from the current pair, retrieved memory, and a compact adversarial contract.
- Worker report sync and manual Revert to Butler both return the worker output to the originating pair.
