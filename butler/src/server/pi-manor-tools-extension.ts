import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { assertProviderPortableToolSchema } from "./butler-agent-tool-schemas.js";
import { callManorHarness, formatManorHarnessResult } from "./pi-manor-harness-client.js";

function piStringEnumSchema<const Values extends readonly string[]>(
  values: Values,
  options: { description?: string } = {}
) {
  const escaped = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return Type.String({
    enum: [...values],
    pattern: `^(?:${escaped.join("|")})$`,
    ...options
  });
}

function resultContent(result: Awaited<ReturnType<typeof callManorHarness>>) {
  return { content: [{ type: "text" as const, text: formatManorHarnessResult(result) }], details: result };
}

function callHarness(action: string, params: Record<string, unknown>, signal?: AbortSignal) {
  return callManorHarness(action, params, process.env, fetch, signal);
}

const previewStartTool = defineTool({
  name: "manor_preview_start",
  label: "Start Preview",
  description: "Start an isolated Manor preview for builds, tests, servers, or browser proof. Normally omit bootstrap_wait_seconds and use the runtime default.",
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    cwd: Type.Optional(Type.String()),
    stack_id: Type.Optional(Type.String()),
    aliases: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), value: Type.String() }))),
    image: Type.Optional(Type.String()),
    egress_profile: Type.Optional(Type.String()),
    egress_domains: Type.Optional(Type.Array(Type.String())),
    bootstrap_wait_seconds: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: 600,
      description: "Optional bootstrap wait. Omit to use the runtime default."
    })),
    bootstrap_hint: Type.Optional(Type.String()),
    heartbeat_kind: Type.Optional(Type.String()),
    heartbeat_target: Type.Optional(Type.String()),
    heartbeat_interval_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 }))
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("preview.start", {
      title: params.title,
      command: params.command,
      port: params.port,
      cwd: params.cwd ?? "",
      stackId: params.stack_id ?? "",
      aliases: params.aliases ?? [],
      env: Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
      image: params.image ?? "",
      egressProfile: params.egress_profile ?? "",
      egressDomains: params.egress_domains ?? [],
      bootstrapWaitSeconds: params.bootstrap_wait_seconds ?? 0,
      bootstrapHint: params.bootstrap_hint ?? "",
      heartbeatKind: params.heartbeat_kind ?? "",
      heartbeatTarget: params.heartbeat_target ?? "",
      heartbeatIntervalSeconds: params.heartbeat_interval_seconds ?? 0
    }, signal));
  }
});

const previewWaitTool = defineTool({
  name: "manor_preview_wait",
  label: "Wait For Preview",
  description: "Wait for a Manor preview to become ready and return its current state.",
  parameters: Type.Object({
    lease_id: Type.String({ minLength: 1 }),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 }))
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("preview.wait", {
      leaseId: params.lease_id,
      timeoutSeconds: params.timeout_seconds ?? 15
    }, signal));
  }
});

const previewInspectTool = defineTool({
  name: "manor_preview_inspect",
  label: "Inspect Preview",
  description: "Inspect a Manor preview's runtime, bootstrap, route, and proof state.",
  parameters: Type.Object({ lease_id: Type.String({ minLength: 1 }) }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("preview.inspect", { leaseId: params.lease_id }, signal));
  }
});

const previewLogsTool = defineTool({
  name: "manor_preview_logs",
  label: "Read Preview Logs",
  description: "Read recent logs from a Manor preview without a shell pipeline.",
  parameters: Type.Object({
    lease_id: Type.String({ minLength: 1 }),
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 }))
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("preview.logs", { leaseId: params.lease_id, tail: params.tail ?? 200 }, signal));
  }
});

const previewExecTool = defineTool({
  name: "manor_preview_exec",
  label: "Run In Preview",
  description: "Run an argv command in a Manor preview. Arguments are preserved without shell quoting or pipelines. The returned exit status and stdout are direct verification evidence; do not recreate them in a separate proof transcript.",
  parameters: Type.Object({
    lease_id: Type.String({ minLength: 1 }),
    argv: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.Optional(Type.String()),
    stdin: Type.Optional(Type.String())
  }),
  async execute(_toolCallId, params, signal) {
    const result = await callHarness("preview.exec", {
      leaseId: params.lease_id,
      commandArgs: params.argv,
      command: params.argv.join(" "),
      cwd: params.cwd ?? "",
      stdin: params.stdin ?? "",
      stdinProvided: params.stdin !== undefined
    }, signal);
    const nestedResult = result.data && typeof result.data === "object"
      ? (result.data as { result?: { exitCode?: unknown } }).result
      : null;
    const exitCode = typeof nestedResult?.exitCode === "number" ? nestedResult.exitCode : null;
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`Preview command failed with exit code ${exitCode}.\n${formatManorHarnessResult(result)}`);
    }
    return resultContent(result);
  }
});

const previewStopTool = defineTool({
  name: "manor_preview_stop",
  label: "Stop Preview",
  description: "Stop a Manor preview after verification is complete.",
  parameters: Type.Object({ lease_id: Type.String({ minLength: 1 }) }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("preview.stop", { leaseId: params.lease_id }, signal));
  }
});

const browserStartTool = defineTool({
  name: "manor_browser_start",
  label: "Start Browser Proof",
  description: "Start a browser proof session against a running Manor preview. Initial page review returns a server-generated manorContentAdmission control object when warning or withholding is needed. Omit mode and resolution for the headless 1080p defaults. A screenshot is a later manor_browser_action with type=screenshot, not a browser mode.",
  parameters: Type.Object({
    lease_id: Type.String({ minLength: 1 }),
    path: Type.Optional(Type.String()),
    target_url: Type.Optional(Type.String()),
    wait_for_selector: Type.Optional(Type.String()),
    post_load_wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 120000 })),
    headers: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), value: Type.String() }))),
    cookies: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), value: Type.String() }))),
    session_cookie: Type.Optional(Type.String()),
    resolution: Type.Optional(piStringEnumSchema(["1080p", "2k"] as const, {
      description: "Named capture resolution. Use 1080p or 2k; pixel dimensions such as 1280x720 are unsupported."
    })),
    mode: Type.Optional(piStringEnumSchema(["headless", "headful"] as const, {
      description: "Browser execution mode. Use headless or headful; screenshot is an action type, not a mode."
    }))
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("browser.use.start_preview", {
      leaseId: params.lease_id,
      path: params.path ?? "",
      targetUrl: params.target_url ?? "",
      waitForSelector: params.wait_for_selector ?? "",
      postLoadWaitMs: params.post_load_wait_ms ?? 0,
      headers: Object.fromEntries((params.headers ?? []).map((entry) => [entry.name, entry.value])),
      cookies: Object.fromEntries((params.cookies ?? []).map((entry) => [entry.name, entry.value])),
      sessionCookie: params.session_cookie ?? "",
      resolution: params.resolution ?? "1080p",
      mode: params.mode ?? "headless"
    }, signal));
  }
});

const browserActionTool = defineTool({
  name: "manor_browser_action",
  label: "Browser Action",
  description: "Run one tracked browser action. Visible page and action output use a structured Content Admission Review envelope and may be warned or withheld. Use wait_for (not wait) for selector, URL, or elapsed-time waits, and evaluate (not exec) for Playwright scripting. evaluate runs an async Node body with page available; read DOM with `return await page.evaluate(() => ...)`. Set auto_capture=false for nonvisual actions. Captured actions require a descriptive label and unique .png filename.",
  parameters: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    type: piStringEnumSchema([
      "click",
      "fill",
      "type",
      "press",
      "hover",
      "select",
      "check",
      "uncheck",
      "scroll",
      "wait_for",
      "navigate",
      "evaluate",
      "screenshot"
    ] as const, { description: "Tracked browser action. Use wait_for, not wait, with ms for an elapsed-time wait. Use evaluate, not exec, for Playwright scripting." }),
    selector: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()),
    values: Type.Optional(Type.Array(Type.String())),
    text: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    url_includes: Type.Optional(Type.String()),
    script: Type.Optional(Type.String({
      description: "Async Node body for evaluate with Playwright page available. To read DOM, use `return await page.evaluate(() => ...)`."
    })),
    ms: Type.Optional(Type.Integer({ minimum: 0 })),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 250 })),
    label: Type.Optional(Type.String()),
    file_name: Type.Optional(Type.String()),
    auto_capture: Type.Optional(Type.Boolean())
  }),
  async execute(_toolCallId, params, signal) {
    const captures = params.type === "screenshot" || params.auto_capture !== false;
    if (captures && (!params.label?.trim() || !params.file_name?.trim())) {
      throw new Error("Captured browser actions require label and file_name.");
    }
    if (captures && !params.file_name!.toLowerCase().endsWith(".png")) {
      throw new Error("Captured browser action file_name must end in .png.");
    }
    return resultContent(await callHarness("browser.use.action", {
      sessionId: params.session_id,
      actionType: params.type,
      selector: params.selector ?? "",
      value: params.value ?? "",
      values: params.values ?? [],
      text: params.text ?? "",
      key: params.key ?? "",
      url: params.url ?? "",
      urlIncludes: params.url_includes ?? "",
      script: params.script ?? "",
      ms: params.ms ?? 0,
      x: params.x ?? 0,
      y: params.y ?? 0,
      timeoutMs: params.timeout_ms ?? 0,
      label: params.label ?? "",
      fileName: params.file_name ?? "",
      autoCapture: params.auto_capture !== false
    }, signal));
  }
});

const browserStopTool = defineTool({
  name: "manor_browser_stop",
  label: "Finish Browser Proof",
  description: "Finish a browser proof session and durably persist its screenshots, video, trace, and manifest. Reference the returned proof run ID in manor_report; do not attach the same evidence again.",
  parameters: Type.Object({
    session_id: Type.String({ minLength: 1 }),
    lease_id: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String())
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("browser.use.stop", {
      sessionId: params.session_id,
      leaseId: params.lease_id ?? "",
      reason: params.reason ?? "completed"
    }, signal));
  }
});

const reportEvidenceKindSchema = piStringEnumSchema([
  "unit_test",
  "integration_test",
  "api_smoke",
  "browser_flow",
  "visual_review",
  "responsive_review",
  "accessibility_review",
  "log_review",
  "data_check",
  "negative_case",
  "build",
  "deploy_health",
  "taste_review",
  "intent_review",
  "manual_waiver",
  "proof",
  "screenshot",
  "video",
  "trace",
  "log",
  "command",
  "file",
  "manual"
] as const, { description: "Evidence category. Use browser_flow or screenshot for browser UI proof." });

const reportEvidenceSchema = Type.Object({
  point_id: Type.Optional(Type.String()),
  matrix_row_id: Type.Optional(Type.String()),
  kind: reportEvidenceKindSchema,
  summary: Type.String({ minLength: 1 }),
  details: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  exit_code: Type.Optional(Type.Integer()),
  proof_run_id: Type.Optional(Type.String({ description: "Exact proof run ID returned by manor_browser_stop." })),
  artifact_id: Type.Optional(Type.String()),
  route: Type.Optional(Type.String()),
  log_ref: Type.Optional(Type.String()),
  data_ref: Type.Optional(Type.String())
});

const reportTool = defineTool({
  name: "manor_report",
  label: "Report To Butler",
  description: "Record the single structured supervisor report after work and verification finish. For UI work, include at least one browser_flow or screenshot evidence item with the exact proof_run_id returned by manor_browser_stop.",
  parameters: Type.Object({
    status: piStringEnumSchema(["completed", "blocked"] as const),
    summary: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(reportEvidenceSchema, {
      description: "Verified evidence. UI completion requires browser_flow or screenshot evidence tied to a proof_run_id."
    }))
  }),
  async execute(_toolCallId, params, signal) {
    return resultContent(await callHarness("report", {
      status: params.status,
      summary: params.summary,
      details: params.details ?? "",
      evidence: (params.evidence ?? []).map((entry) => ({
        pointId: entry.point_id ?? null,
        matrixRowId: entry.matrix_row_id ?? null,
        kind: entry.kind,
        summary: entry.summary,
        details: entry.details ?? null,
        command: entry.command ?? null,
        exitCode: entry.exit_code ?? null,
        proofRunId: entry.proof_run_id ?? null,
        artifactId: entry.artifact_id ?? null,
        route: entry.route ?? null,
        logRef: entry.log_ref ?? null,
        dataRef: entry.data_ref ?? null
      }))
    }, signal));
  }
});

export const manorWorkerTools = [
  previewStartTool,
  previewWaitTool,
  previewInspectTool,
  previewLogsTool,
  previewExecTool,
  previewStopTool,
  browserStartTool,
  browserActionTool,
  browserStopTool,
  reportTool
];

for (const tool of manorWorkerTools) assertProviderPortableToolSchema(tool.name, tool.parameters);

export default async function manorToolsExtension(pi: ExtensionAPI): Promise<void> {
  for (const tool of manorWorkerTools) pi.registerTool(tool);
}
