import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const harnessPath = new URL("../../../docker/worker/manor-harness.mjs", import.meta.url);

type HarnessRequest = {
  token?: string;
  action?: string;
  params?: Record<string, unknown>;
  requestPath?: string;
};

async function readJsonBody(request: IncomingMessage): Promise<HarnessRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HarnessRequest;
}

async function captureHarnessAction(args: string[], options: { cwd?: string; stdin?: string } = {}): Promise<HarnessRequest> {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-cli-test-"));
  const cwd = options.cwd ?? path.join(root, "workspace");
  const harnessHome = path.join(root, "harness-home");
  const registryPath = path.join(harnessHome, "harness-capabilities.json");
  await mkdir(harnessHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({
      capabilities: [
        {
          id: "capability-1",
          token: "token-1",
          threadId: "thread-1",
          cwd,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })}\n`,
    "utf8"
  );

  let received: HarnessRequest | null = null;
  const server = createServer(async (request, response) => {
    const expectedPath = "/api/harness/action";
    if (request.url !== expectedPath) {
      response.writeHead(404).end();
      return;
    }
    received = await readJsonBody(request);
    received.requestPath = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, text: "ok", data: {} }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [harnessPath.pathname, ...args], {
        cwd,
        env: {
          ...process.env,
          MANOR_HARNESS_HOME: harnessHome,
          MANOR_HARNESS_REGISTRY_PATH: registryPath,
          MANOR_BUTLER_BASE_URL: `http://127.0.0.1:${address.port}`
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.end(options.stdin ?? "");
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(received, "expected harness action request");
    return received;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("manor-harness records piped Markdown proof and a simple report", async () => {
  const proof = await captureHarnessAction(
    ["--thread", "thread-1", "proof", "text", "--title", "Directory listing", "--file-name", "directory-listing.md"],
    { stdin: "$ ls -la\ntotal 0\n" }
  );
  assert.equal(proof.action, "proof.text");
  assert.deepEqual(proof.params, {
    title: "Directory listing",
    label: "",
    fileName: "directory-listing.md",
    contentType: "",
    text: "$ ls -la\ntotal 0\n"
  });

  const report = await captureHarnessAction([
    "--thread", "thread-1", "report", "--status", "completed", "--summary", "Removed the requested files."
  ]);
  assert.equal(report.action, "report");
  assert.equal(report.params?.status, "completed");
  assert.equal(report.params?.summary, "Removed the requested files.");
  assert.equal(report.params?.claims, null);
  assert.deepEqual(report.params?.evidence, []);
});

test("manor-harness proof subcommand help is available without a job binding", async () => {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath.pathname, "proof", "text", "--help"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /piped stdin or --body/);
  assert.match(result.stdout, /Markdown is the default format/);
});

test("manor-harness publishes a derived output as a new input version", async () => {
  const request = await captureHarnessAction([
    "input", "publish", "/outputs/thread-1/revised.pdf",
    "--from", "file-source",
    "--name", "revised-cv.pdf",
    "--content-type", "application/pdf"
  ]);
  assert.equal(request.action, "input.publish_version");
  assert.deepEqual(request.params, {
    filePath: "/outputs/thread-1/revised.pdf",
    sourceReferenceId: "file-source",
    name: "revised-cv.pdf",
    contentType: "application/pdf"
  });
});

test("manor-harness resolves lifecycle cwd flags before forwarding broker requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-cwd-test-"));
  const workspace = path.join(root, "workspace");
  const relativeCwd = "apps/demo";
  await mkdir(workspace, { recursive: true });
  const expectedCwd = path.join(await realpath(workspace), relativeCwd);

  const previewStart = await captureHarnessAction([
    "preview", "start",
    "--cwd", relativeCwd,
    "--command", "npm run dev",
    "--port", "3000"
  ], { cwd: workspace });
  assert.equal(previewStart.action, "preview.start");
  assert.equal(previewStart.requestPath, "/api/harness/action");
  assert.equal(previewStart.params?.cwd, expectedCwd);

  const serviceStart = await captureHarnessAction([
    "service", "start",
    "--template", "redis",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(serviceStart.action, "service.start");
  assert.equal(serviceStart.params?.cwd, expectedCwd);

  const stackStart = await captureHarnessAction([
    "stack", "start",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(stackStart.action, "stack.start");
  assert.equal(stackStart.params?.cwd, expectedCwd);

  const desktopStart = await captureHarnessAction([
    "desktop", "use", "start",
    "--command", "echo ok",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(desktopStart.action, "desktop.use.start");
  assert.equal(desktopStart.params?.cwd, expectedCwd);
});

test("manor-harness preserves preview exec cwd as an in-container path", async () => {
  const previewRelativeExec = await captureHarnessAction([
    "preview", "exec", "preview-1",
    "--cwd", "app/subdir",
    "--", "pwd"
  ]);
  assert.equal(previewRelativeExec.action, "preview.exec");
  assert.equal(previewRelativeExec.params?.cwd, "app/subdir");

  const previewAbsoluteExec = await captureHarnessAction([
    "preview", "exec", "preview-1",
    "--cwd", "/tmp/manor-preview-workspaces/preview-1/app",
    "--", "pwd"
  ]);
  assert.equal(previewAbsoluteExec.action, "preview.exec");
  assert.equal(previewAbsoluteExec.params?.cwd, "/tmp/manor-preview-workspaces/preview-1/app");
});

test("manor-harness forwards bounded preview lifecycle waits", async () => {
  const previewWait = await captureHarnessAction([
    "preview", "wait", "preview-1",
    "--timeout-seconds", "20"
  ]);
  assert.equal(previewWait.action, "preview.wait");
  assert.equal(previewWait.params?.leaseId, "preview-1");
  assert.equal(previewWait.params?.timeoutSeconds, 20);
});

test("manor-harness preserves service exec cwd as an in-container path", async () => {
  const serviceRelativeExec = await captureHarnessAction([
    "service", "exec", "service-1",
    "--cwd", "data",
    "--", "pwd"
  ]);
  assert.equal(serviceRelativeExec.action, "service.exec");
  assert.equal(serviceRelativeExec.params?.cwd, "data");

  const serviceAbsoluteExec = await captureHarnessAction([
    "service", "exec", "service-1",
    "--cwd", "/data",
    "--", "pwd"
  ]);
  assert.equal(serviceAbsoluteExec.action, "service.exec");
  assert.equal(serviceAbsoluteExec.params?.cwd, "/data");
});

test("manor-harness forwards explicit stack promotion confirmation", async () => {
  const request = await captureHarnessAction([
    "stack", "promote", "stack-alpha",
    "--to", "project-alpha-base",
    "--confirm-target", "project-alpha-base"
  ]);
  assert.equal(request.action, "stack.promote");
  assert.deepEqual(request.params, {
    stackId: "stack-alpha",
    targetStorageKey: "project-alpha-base",
    confirmTargetStorageKey: "project-alpha-base"
  });
});

test("manor-harness forwards payload current requests", async () => {
  const request = await captureHarnessAction(["--thread", "thread-1", "payload", "current"]);
  assert.equal(request.action, "payload.current");
});

test("manor-harness forwards job manifest inspection requests", async () => {
  const request = await captureHarnessAction(["--thread", "thread-1", "manifest", "current"]);
  assert.equal(request.action, "manifest.current");
});

test("manor-harness forwards deterministic job output reconciliation requests", async () => {
  const request = await captureHarnessAction(["--thread", "thread-1", "manifest", "reconcile"]);
  assert.equal(request.action, "manifest.reconcile");
});

test("manor-harness forwards scoped vision inspection requests", async () => {
  const request = await captureHarnessAction([
    "--thread", "thread-1", "vision", "inspect",
    "--image", "image-1", "--image", "image-2",
    "--question", "What error is visible?"
  ]);
  assert.equal(request.action, "vision.inspect");
  assert.deepEqual(request.params, {
    imageReferenceIds: ["image-1", "image-2"],
    question: "What error is visible?"
  });
});

test("manor-harness requires explicit thread binding for payload requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-payload-binding-test-"));
  const cwd = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await mkdir(path.join(codexHome, "manor"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(codexHome, "manor", "harness-capabilities.json"),
    `${JSON.stringify({
      capabilities: [
        { id: "capability-1", token: "token-1", threadId: "thread-1", cwd, createdAt: 1, updatedAt: 1 }
      ]
    })}\n`,
    "utf8"
  );

  const result = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [harnessPath.pathname, "payload", "current"], {
      cwd,
      env: { ...process.env, MANOR_HARNESS_HOME: path.join(codexHome, "manor"), MANOR_BUTLER_BASE_URL: "http://127.0.0.1:1" },
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Payload actions require an explicit job binding/);
});

test("manor-harness diagnoses missing bindings with Butler and broker health", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-health-test-"));
  const codexHome = path.join(root, "codex-home");
  await mkdir(path.join(codexHome, "manor"), { recursive: true });
  await writeFile(path.join(codexHome, "manor", "harness-capabilities.json"), JSON.stringify({ capabilities: [] }), "utf8");

  const butler = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  const broker = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => butler.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const butlerAddress = butler.address();
  const brokerAddress = broker.address();
  assert.ok(butlerAddress && typeof butlerAddress === "object");
  assert.ok(brokerAddress && typeof brokerAddress === "object");

  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [harnessPath.pathname, "--thread", "thread-1", "status"], {
        cwd: root,
        env: {
          ...process.env,
          MANOR_HARNESS_HOME: path.join(codexHome, "manor"),
          MANOR_BUTLER_BASE_URL: `http://127.0.0.1:${butlerAddress.port}`,
          MANOR_RUNTIME_BROKER_URL: `http://127.0.0.1:${brokerAddress.port}`
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /No Manor harness capability was found/);
    assert.match(result.stderr, /Control plane: Butler ok; runtime broker ok\./);
  } finally {
    await new Promise<void>((resolve) => butler.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});
