# Security Policy

Manor is a trusted personal worker appliance. It is designed for one operator on infrastructure they control, not for hostile multi-tenant use.

## Supported Versions

Until the project has tagged releases, security fixes target the current `main` branch.

## Security Model

Manor assumes:

- the Docker host is trusted by the operator
- Butler is not exposed directly to the public internet
- Codex and Butler run inside the same trusted appliance boundary
- the runtime broker is trusted to manage Docker resources
- previews and disposable services are isolated for operational hygiene, not as a complete hostile-code sandbox

Manor does not currently claim:

- multi-tenant isolation
- protection from a malicious local operator
- protection from a compromised Docker daemon or host
- safe public exposure of the Butler UI
- safe execution of arbitrary untrusted code

Use private ingress, local binding, VPN, tailnet, or similar controls when accessing Manor remotely.

## Reporting a Vulnerability

Report vulnerabilities through GitHub private vulnerability reporting.

Do not include exploit details, secrets, tokens, private URLs, or reproduction steps in a public issue.

Please include:

- affected component
- expected impact
- reproduction summary
- affected configuration
- whether credentials, host access, or public exposure are required

## Handling Secrets

Do not commit API keys, session tokens, ChatGPT auth data, GitHub credentials, local state volumes, captured browser sessions, or proof artifacts that contain sensitive user data.

If a secret is exposed, rotate it immediately. Removing it from a later commit is not enough.

## Hardening Expectations

For remote use:

- keep Butler behind private access controls
- restrict inbound host ports
- keep Docker and base images updated
- review runtime logs when debugging suspicious behavior
- prefer short-lived test credentials inside previews

Security-sensitive changes should include validation notes and, when practical, a small regression test.
