import { Type } from "@sinclair/typebox";

const FORBIDDEN_PROVIDER_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$ref",
  "allOf",
  "anyOf",
  "const",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "oneOf",
  "patternProperties",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
]);

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stringEnumSchema<const Values extends readonly string[]>(
  values: Values,
  options: { description?: string; default?: Values[number] } = {}
) {
  if (values.length === 0) throw new Error("String enum schemas require at least one value.");
  return Type.String({
    enum: [...values],
    pattern: `^(?:${values.map(escapeRegexLiteral).join("|")})$`,
    ...options
  });
}

export function providerToolSchemaViolations(schema: unknown, path = "parameters"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path} must be a schema object`];
  const record = schema as Record<string, unknown>;
  const violations = Object.keys(record)
    .filter((key) => FORBIDDEN_PROVIDER_SCHEMA_KEYWORDS.has(key))
    .map((key) => `${path}.${key}`);
  if (Array.isArray(record.type)) violations.push(`${path}.type`);

  for (const [key, value] of Object.entries(record)) {
    if (["default", "enum", "example", "examples"].includes(key) || !value || typeof value !== "object") continue;
    if (key === "properties" && !Array.isArray(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value as Record<string, unknown>)) {
        violations.push(...providerToolSchemaViolations(propertySchema, `${path}.properties.${propertyName}`));
      }
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry && typeof entry === "object") {
          violations.push(...providerToolSchemaViolations(entry, `${path}.${key}[${index}]`));
        }
      });
      continue;
    }
    violations.push(...providerToolSchemaViolations(value, `${path}.${key}`));
  }
  return violations;
}

export function assertProviderPortableToolSchema(toolName: string, schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`Tool ${toolName} parameters must be a top-level object schema.`);
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object" || !root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    throw new Error(`Tool ${toolName} parameters must expose top-level type=object and properties.`);
  }
  const violations = providerToolSchemaViolations(schema);
  if (violations.length > 0) {
    throw new Error(`Tool ${toolName} uses provider-fragile schema keywords: ${violations.join(", ")}.`);
  }
}

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
    imageSetupCommand: Type.Optional(Type.String({
      minLength: 1,
      description: "Optional root-only setup command used to prepare an isolated derived image before the non-root preview starts. The preparation receives no workspace, secrets, inputs, outputs, or durable mounts. Never include secrets in this command."
    })),
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
    heartbeatKind: Type.Optional(stringEnumSchema(
      ["none", "http", "tcp", "command"] as const,
      { description: "Heartbeat type. Defaults to http for previews." }
    )),
    heartbeatTarget: Type.Optional(Type.String({
      minLength: 1,
      description: "Heartbeat target: an HTTP path like /health, a TCP host:port, or a shell command. Loopback hosts refer to the preview container. Defaults to / for HTTP."
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
