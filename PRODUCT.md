# Product

## Register

product

## Users

Manor is used by one trusted operator who supervises Butler and provider-backed Workers while they build, verify, and maintain projects inside a local Docker appliance.

## Product Purpose

Manor keeps long-running agent work organized, observable, and contained. Success means the operator can delegate work, inspect evidence, and make high-risk runtime decisions without guessing what the agents or containers are doing.

The main product promise is async leverage. The operator should give intent, then Butler and the active Worker should do the investigation, execution, verification, and proof gathering with very little hand-holding.

A Worker is Manor's product role across providers. Manor can run it through the Codex app-server harness for OpenAI/Codex models or the Pi RPC harness for supported Ollama and OpenCode Go models. Butler keeps the job contract and review model consistent across them.

Manor has two agent environments. Butler contains the Pi-backed supervisor. The Worker environment contains both Worker harnesses and exposes one Worker CLI regardless of which harness a job uses.

## Brand Personality

Direct, careful, and work-focused. The interface should feel like an honest control room: compact, explicit, and calm under operational pressure.

## Anti-references

Do not make Manor feel like a hosted multi-tenant SaaS dashboard, a decorative AI chat toy, or a vague automation black box. Avoid hidden destructive actions, ceremonial confirmations, and magic phrases the operator has to guess.

## Design Principles

- Show the actual operational state before asking the operator to act.
- Put high-risk actions behind clear, plain-language confirmation flows.
- Keep controls familiar and dense enough for repeated supervisory work.
- Prefer evidence and exact details over optimistic status copy.
- Make trust boundaries visible when an action affects the live Manor stack.
- Infer work depth internally from the operator's intent instead of asking the operator to choose it.
- Treat taste, intent fit, and verification quality as part of completion, especially for UI, API, writing, and operator-facing workflows.
- Make Butler acceptance adversarial: the worker submits evidence, Butler decides whether it is good enough.
- Give the operator a compact proof dossier so they can trust the result without reading the full worker transcript.
- Show the active Worker provider, model, and reasoning option where that identity affects a decision.
- Treat provider or harness changes as explicit cold handoffs that preserve the job record without implying hidden state transfer.

## Accessibility & Inclusion

Product UI should meet WCAG AA contrast for text and controls, keep keyboard-accessible dialogs and actions, and avoid motion that is required to understand or complete a workflow.
