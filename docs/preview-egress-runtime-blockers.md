# Preview egress and runtime blocker triage

When browser proof reaches a Cloudflare Managed Challenge or Turnstile page instead of the target app/API, Manor now classifies the proof as `failureKind: "egress"` and records the signal in the proof manifest. Treat this as an operator/project/external reachability blocker, not as proof that the app failed.

Recommended routes:

- If the destination only needs outbound HTTP(S) from a preview, start the preview with the narrowest operator-approved egress path: `--egress-domain <host>` for a domain-scoped dynamic policy, or `--egress-profile <name>` for a configured profile from `config/preview-egress-profiles.json`.
- If the repository requires a Docker-compose-style microservice stack, use a Manor stack and attach previews/services to it with `--stack <stackSelector>` instead of trying to run Docker inside the normal preview image.
- If the external service still serves a managed challenge, ask the operator/project owner to allowlist the Manor egress route or provide a backend preview/API route that is accessible from Manor automation.

Do not bypass interactive challenges with secrets or manual tokens in proof artifacts. Keep any allowlisting operator-controlled and avoid committing private hostnames, tokens, or sensitive challenge output.
