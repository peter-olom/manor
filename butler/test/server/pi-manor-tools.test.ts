import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callManorHarness } from "../../src/server/pi-manor-harness-client.js";
import manorToolsExtension, { manorWorkerTools } from "../../src/server/pi-manor-tools-extension.js";

type WorkerTool = {
  name: string;
  description: string;
  parameters: object & { properties?: Record<string, { description?: string }> };
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
};

const workerTools = manorWorkerTools as unknown as WorkerTool[];

function schemaLiterals(schema: unknown): unknown[] {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "const")) return [record.const];
  return Object.values(record).flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap(schemaLiterals);
    return schemaLiterals(value);
  });
}

test("Manor Worker tools expose bounded preview, browser, and report operations", () => {
  assert.deepEqual(workerTools.map((tool) => tool.name), [
    "manor_preview_start",
    "manor_preview_wait",
    "manor_preview_inspect",
    "manor_preview_logs",
    "manor_preview_exec",
    "manor_preview_stop",
    "manor_browser_start",
    "manor_browser_action",
    "manor_browser_stop",
    "manor_report"
  ]);
  const previewStart = workerTools.find((tool) => tool.name === "manor_preview_start")!;
  const previewWait = workerTools.find((tool) => tool.name === "manor_preview_wait")!;
  const browserStart = workerTools.find((tool) => tool.name === "manor_browser_start")!;
  assert.ok(previewStart.parameters.properties.env);
  assert.ok(previewStart.parameters.properties.stack_id);
  assert.ok(previewStart.parameters.properties.egress_profile);
  assert.match(previewStart.description, /omit bootstrap_wait_seconds.*runtime default/i);
  assert.match(previewStart.parameters.properties.bootstrap_wait_seconds?.description ?? "", /omit.*runtime default/i);
  assert.equal((previewWait.parameters.properties.timeout_seconds as { maximum?: number }).maximum, 60);
  assert.ok(browserStart.parameters.properties.headers);
  assert.ok(browserStart.parameters.properties.cookies);
  assert.ok(browserStart.parameters.properties.session_cookie);
});

test("Manor Worker extension registers manor_report", async () => {
  const registered: string[] = [];
  await manorToolsExtension({
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    }
  } as never);

  assert.ok(registered.includes("manor_report"));
  assert.equal(registered.at(-1), "manor_report");
});

test("manor_browser_start documents and enforces supported mode and resolution values", () => {
  const browserStart = workerTools.find((tool) => tool.name === "manor_browser_start")!;
  assert.deepEqual(schemaLiterals(browserStart.parameters.properties?.mode), ["headless", "headful"]);
  assert.deepEqual(schemaLiterals(browserStart.parameters.properties?.resolution), ["1080p", "2k"]);
  assert.match(browserStart.parameters.properties?.mode?.description ?? "", /headless or headful.*screenshot is an action type, not a mode/i);
  assert.match(browserStart.parameters.properties?.resolution?.description ?? "", /1080p or 2k.*1280x720 are unsupported/i);
});

test("manor_browser_action exposes only sidecar-supported action names", () => {
  const browserAction = workerTools.find((tool) => tool.name === "manor_browser_action")!;
  assert.deepEqual(schemaLiterals(browserAction.parameters.properties?.type), [
    "click", "fill", "type", "press", "hover", "select", "check", "uncheck",
    "scroll", "wait_for", "navigate", "evaluate", "screenshot"
  ]);
  assert.match(browserAction.description, /wait_for \(not wait\)/i);
  assert.match(browserAction.description, /evaluate \(not exec\)/i);
  assert.match(browserAction.description, /page\.evaluate/i);
  assert.match(browserAction.description, /auto_capture=false for nonvisual/i);
  assert.match(browserAction.parameters.properties?.script?.description ?? "", /async Node body.*page available.*page\.evaluate/i);
});

test("manor_report exposes validator-supported evidence kinds and UI guidance", () => {
  const report = workerTools.find((tool) => tool.name === "manor_report")!;
  const evidenceSchema = report.parameters.properties?.evidence as unknown as {
    description?: string;
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(schemaLiterals(evidenceSchema.items?.properties?.kind).includes("browser_flow"));
  assert.ok(schemaLiterals(evidenceSchema.items?.properties?.kind).includes("screenshot"));
  assert.equal(schemaLiterals(evidenceSchema.items?.properties?.kind).includes("browser"), false);
  assert.match(report.description, /browser_flow or screenshot.*proof_run_id/i);
  assert.match(evidenceSchema.description ?? "", /browser_flow or screenshot.*proof_run_id/i);
});

test("manor_report forwards structured supervisor evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-report-"));
  const registry = path.join(dir, "capabilities.json");
  await writeFile(registry, JSON.stringify({ capabilities: [{ threadId: "pi-report-1", token: "report-token" }] }));
  let body: Record<string, unknown> | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, text: "report recorded" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const previous = {
    threadId: process.env.MANOR_THREAD_ID,
    registryPath: process.env.MANOR_HARNESS_REGISTRY_PATH,
    baseUrl: process.env.MANOR_BUTLER_BASE_URL
  };

  try {
    process.env.MANOR_THREAD_ID = "pi-report-1";
    process.env.MANOR_HARNESS_REGISTRY_PATH = registry;
    process.env.MANOR_BUTLER_BASE_URL = `http://127.0.0.1:${address.port}`;
    const report = workerTools.find((tool) => tool.name === "manor_report")!;
    await report.execute("report-call-1", {
      status: "completed",
      summary: "UI verified",
      details: "Build and browser proof passed.",
      evidence: [{
        point_id: "point-1",
        matrix_row_id: "row-1",
        kind: "browser_flow",
        summary: "Dashboard rendered",
        details: "Desktop dashboard proof",
        command: "npm test",
        exit_code: 0,
        proof_run_id: "proof-1",
        artifact_id: "artifact-1",
        route: "/dashboard",
        log_ref: "log-1",
        data_ref: "data-1"
      }]
    });

    assert.deepEqual(body, {
      token: "report-token",
      action: "report",
      params: {
        status: "completed",
        summary: "UI verified",
        details: "Build and browser proof passed.",
        evidence: [{
          pointId: "point-1",
          matrixRowId: "row-1",
          kind: "browser_flow",
          summary: "Dashboard rendered",
          details: "Desktop dashboard proof",
          command: "npm test",
          exitCode: 0,
          proofRunId: "proof-1",
          artifactId: "artifact-1",
          route: "/dashboard",
          logRef: "log-1",
          dataRef: "data-1"
        }]
      }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries({
      MANOR_THREAD_ID: previous.threadId,
      MANOR_HARNESS_REGISTRY_PATH: previous.registryPath,
      MANOR_BUTLER_BASE_URL: previous.baseUrl
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Manor Worker client binds the current job capability and preserves structured params", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-tools-"));
  const registry = path.join(dir, "capabilities.json");
  await writeFile(registry, JSON.stringify({ capabilities: [{ threadId: "pi-job-1", token: "secret-token" }] }));
  let body: Record<string, unknown> | null = null;
  const result = await callManorHarness(
    "preview.exec",
    { leaseId: "lease-1", commandArgs: ["npm", "test", "--", "value with spaces"] },
    {
      MANOR_THREAD_ID: "pi-job-1",
      MANOR_HARNESS_REGISTRY_PATH: registry,
      MANOR_BUTLER_BASE_URL: "http://butler.test"
    },
    async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, text: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  assert.equal(result.text, "done");
  assert.deepEqual(body, {
    token: "secret-token",
    action: "preview.exec",
    params: { leaseId: "lease-1", commandArgs: ["npm", "test", "--", "value with spaces"] }
  });
});

test("Manor Worker client propagates harness failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-tools-error-"));
  const registry = path.join(dir, "capabilities.json");
  await writeFile(registry, JSON.stringify({ capabilities: [{ threadId: "pi-job-2", token: "secret-token" }] }));

  await assert.rejects(
    () => callManorHarness(
      "preview.wait",
      { leaseId: "missing" },
      { MANOR_THREAD_ID: "pi-job-2", MANOR_HARNESS_REGISTRY_PATH: registry },
      async () => new Response(JSON.stringify({ ok: false, error: "Preview is unavailable" }), { status: 400 })
    ),
    /Preview is unavailable/
  );
});

test("Manor Worker client propagates cancellation to an active harness request", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manor-worker-tools-cancel-"));
  const registry = path.join(dir, "capabilities.json");
  await writeFile(registry, JSON.stringify({ capabilities: [{ threadId: "pi-job-cancel", token: "secret-token" }] }));
  const controller = new AbortController();
  let observedSignal: AbortSignal | null = null;
  let noteRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { noteRequestStarted = resolve; });

  const request = callManorHarness(
    "browser.action",
    { sessionId: "session-1", action: { type: "wait", ms: 70_000 } },
    { MANOR_THREAD_ID: "pi-job-cancel", MANOR_HARNESS_REGISTRY_PATH: registry },
    ((_input, init) => {
      observedSignal = init?.signal ?? null;
      noteRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as typeof fetch,
    controller.signal
  );

  await requestStarted;
  controller.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(observedSignal, controller.signal);
});
