# Security Policy

Manor is a trusted personal worker appliance for one operator on infrastructure they control.

## Supported Versions

Until the project has tagged releases, security fixes target the current `main` branch.

## Security Model

Manor assumes:

- the Docker host is trusted by the operator
- Butler is not exposed directly to the public internet
- Butler and the Pi Worker harness are trusted appliance components
- configured model providers are data processors for the prompts, files, and tool results sent to them
- the Worker host and Butler run as separate services inside the same trusted appliance boundary
- Butler contains only its own Pi-backed supervisor agent
- Pi RPC Worker sessions execute inside the Worker host boundary
- the runtime broker is trusted to manage Docker resources
- previews and disposable services are isolated for operational hygiene, not as a complete security sandbox
- Worker and Butler clients are configured to send HTTP and HTTPS through Manor's proxy; fresh installs allow public proxy destinations while the proxy blocks private and internal destinations

Manor does not currently claim:

- multi-tenant isolation
- protection from a malicious local operator
- protection from a compromised Docker daemon or host
- safe public exposure of the Butler UI
- safe execution of arbitrary untrusted code

Use private ingress, local binding, VPN, tailnet, or similar controls when accessing Manor remotely.

The selected model provider is also a data boundary. Prompts, attachments, tool results, and job context sent to a remote provider leave the Docker host and are handled under that provider's terms. Local Ollama inference stays inside the appliance unless the job uses an external tool or service.

## Content Admission Review

Content Admission Review checks bounded representations from Manor's standard repository, web search/fetch, and browser ingress for prompt injection and other instructions aimed at agents, tools, credentials, or policy.

The reviewer runs as an isolated defensive model task with web tools disabled and a strict structured verdict. The operator can pin its model under Settings → Security or leave it on explicit automatic selection, which uses the first authenticated background model available. Verdicts are cached by source and content identity. Manor does not persist the full reviewed payload. The cache stores the digest, verdict, confidence, bounded evidence excerpts, explanation, safe summary, and review time.

The available modes are:

- **Review**: warn and continue. Reviewer failures are visible and fail open.
- **Enforce**: withhold hostile web and browser content. Hostile repository commands fail after review, with imported files left on disk. Reviewer failures fail closed.
- **Off**: skip CAR.

Review is the default. CAR runs automatically during interactive and unattended work and does not wait for operator confirmation.

CAR reduces exposure on the common paths Manor controls. Repository review uses a bounded snapshot of selected commit objects, filenames, instruction-bearing files, and instruction-like matches. Web and browser inputs are bounded as well. Custom network clients, package installers, mounted files, content outside the reviewed representation, and other ingestion paths can bypass it. CAR does not guarantee prevention of secret disclosure or exfiltration after an agent has access to sensitive data.

Runtime egress is a separate proxy control. Internet mode allows public HTTP and HTTPS through the proxy. Restricted mode allows only built-in and operator-added hosts. The proxy blocks private and internal destinations in both modes. This control applies only to clients using the shared Butler and Worker proxy. It does not cover preview runtimes, Playwright browser or desktop-proof sessions, image pulls, host traffic, named Manor services on the bypass list, non-proxy protocols, or Butler software that opens a direct connection. Existing connections may remain open after a policy change.

Operators with a stricter risk model should use Restricted runtime egress where that proxy boundary applies, keep secrets outside agent-readable processes where possible, and add host, network, or credential-broker controls around the appliance.

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
- enable only the Worker providers you intend to trust with job data
- use Restricted runtime egress when shared-proxy clients should reach only built-in and operator-approved hosts
- keep Content Admission Review enabled and choose Enforce when blocked delivery is worth the repository-import limitation
- keep Docker and base images updated
- review runtime logs when debugging suspicious behavior
- prefer short-lived test credentials inside previews

Security-sensitive changes should include validation notes and, when practical, a small regression test.
