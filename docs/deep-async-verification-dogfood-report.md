# Deep Async Verification Dogfood Report

## Human Job

A Manor operator needs to delegate non-trivial work and trust the closeout while staying out of the worker transcript.

## What Changed

Butler now turns delegated work into an internal verification contract. Codex gets the same behavior standard Butler uses to review it: preserve intent, investigate current state, choose a practical route, verify deeply, and submit evidence against the acceptance points.

The operator does not choose a depth setting. The depth is internal. The visible change is a stronger dossier and stricter review.

## Backend Dogfood

Scenario: API work that claims completion.

Before this change, a backend worker could send a text report like "done, tested manually." Butler still had a checklist, but the operator often had to read the transcript or ask whether an endpoint, failure path, or logs were actually checked.

After this change:

- a completed deep API report without point-specific evidence is rejected
- evidence must map to each worker-owned verification row
- API work must include request-level smoke evidence, failure-path evidence, and log or runtime review
- Butler still has to accept or waive every acceptance point before a completed closeout can be posted
- the final closeout includes a proof dossier

Automated dogfood coverage walks that loop end to end: weak evidence rejection, corrected structured evidence, Butler review, closeout gate, and proof dossier generation.

## UI Dogfood

Scenario: UI work that claims completion.

Before this change, a UI report could lean too much on text. A proof artifact might exist, but the operator still had to infer whether the result looked coherent, worked across viewport sizes, and avoided adding another control to manage work depth.

After this change:

- text-only proof does not satisfy UI completion
- UI completion requires screenshot or video proof
- responsive, accessibility, and taste evidence are required
- Butler can reject an otherwise valid report for weak operator-facing intent fit
- rejected points become one private rework instruction
- the final dossier includes the proof review verdict and visible-state note

Automated dogfood coverage runs that loop with a weak proof rejection, private rework, corrected worker report, persisted proof review, accepted checklist, and final proof dossier.

## Operator Effort

The old operator burden was: delegate, watch progress, ask what was actually checked, inspect the transcript, and decide whether the worker's confidence was earned.

The new operator burden should be: delegate, wait for Butler, scan the dossier, and only step in when Butler surfaces a real risk or decision.

## Live Stack Check

The automated dogfood covers the core state machine and gates. The local stack was rebuilt for the Butler and Codex worker services, then restarted against the updated source.

Post-restart checks passed:

- Butler and Codex worker containers are running and healthy.
- The local health endpoint returns `{"ok":true}`.
- The served web app references the newly built dossier UI assets.
- The scratch-pad API responds successfully.
- The worker harness help shows point-specific evidence reporting support.
- The worker container sees the updated model instructions, including the requirement not to shrink broad tasks and to report point-specific evidence.
- Recent logs show startup output and a stale temp cleanup warning from the worker container, but no fatal, panic, unhandled exception, type error, or runtime crash.
