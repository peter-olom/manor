import { Type } from "@sinclair/typebox";

export function stringMapSchema() {
  return Type.Object({}, { additionalProperties: Type.String() });
}

export function startPreviewSchema() {
  return Type.Object({
    threadId: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    title: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    stackId: Type.Optional(Type.String()),
    aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    env: Type.Optional(stringMapSchema()),
    image: Type.Optional(Type.String()),
    egressProfile: Type.Optional(Type.String({
      minLength: 1,
      description: "Defaults to direct internet access. Use 'none' to block outbound traffic or a named preview egress profile such as 'web' to restrict it."
    })),
    egressDomains: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      description: "Explicit domain allowlist for this preview only, such as api.openrouter.ai or .cloudflare.com."
    }))),
    bootstrapWaitSeconds: Type.Optional(Type.Number({
      minimum: 1,
      description: "Maximum time to wait for preview bootstrap before returning its current state."
    })),
    bootstrapHint: Type.Optional(Type.String({
      minLength: 1,
      description: "Short hint like 'installing deps' or 'running migrations'."
    })),
    heartbeatKind: Type.Optional(Type.Union(
      [Type.Literal("none"), Type.Literal("http"), Type.Literal("tcp"), Type.Literal("command")],
      { description: "Heartbeat type. Defaults to http for previews." }
    )),
    heartbeatTarget: Type.Optional(Type.String({
      minLength: 1,
      description: "Heartbeat target such as /health, 127.0.0.1:3000, or a shell command. Defaults to / when the heartbeat kind is omitted."
    })),
    heartbeatIntervalSeconds: Type.Optional(Type.Number({
      minimum: 1,
      description: "How often Manor should retry the heartbeat during bootstrap."
    })),
    sticky: Type.Optional(Type.Boolean({
      description: "Keep this preview lease across automatic cleanup so later jobs can reuse it."
    })),
    leaseTtlMinutes: Type.Optional(Type.Number({
      minimum: 1,
      description: "Override the cleanup TTL for this preview lease when sticky is false."
    }))
  });
}

export function reviewPreviewProofSchema() {
  return Type.Object({
    leaseId: Type.Optional(Type.String({ minLength: 1, description: "Active preview lease selector. Prefer an exact runId after the browser session has stopped." })),
    threadId: Type.Optional(Type.String({ minLength: 1, description: "Job selector. With several proof runs and no runId, this lists exact run coverage without invoking vision." })),
    runId: Type.Optional(Type.String({ minLength: 1, description: "Exact proof run ID returned by the stopped browser session. Scope it with threadId or leaseId; do not pass 'latest'." })),
    expectedOutcome: Type.Optional(Type.String({ description: "Concise overall visible outcome for this proof run, not one checklist point at a time." }))
  });
}
