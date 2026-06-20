import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const harnessPath = new URL("../../../docker/codex-box/manor-harness.mjs", import.meta.url);

type HarnessRequest = {
  token?: string;
  action?: string;
  params?: Record<string, unknown>;
};

async function readJsonBody(request: IncomingMessage): Promise<HarnessRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HarnessRequest;
}

async function captureHarnessAction(args: string[], options: { cwd?: string } = {}): Promise<HarnessRequest> {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-cli-test-"));
  const cwd = options.cwd ?? path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await mkdir(path.join(codexHome, "manor"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(codexHome, "manor", "harness-capabilities.json"),
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
    if (request.url !== "/api/codex-harness/action") {
      response.writeHead(404).end();
      return;
    }
    received = await readJsonBody(request);
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
          CODEX_HOME: codexHome,
          MANOR_BUTLER_BASE_URL: `http://127.0.0.1:${address.port}`
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
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.ok(received, "expected harness action request");
    return received;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("manor-harness resolves lifecycle cwd flags before forwarding broker requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-harness-cwd-test-"));
  const workspace = path.join(root, "workspace");
  const relativeCwd = "apps/demo";

  const previewStart = await captureHarnessAction([
    "preview", "start",
    "--cwd", relativeCwd,
    "--command", "npm run dev",
    "--port", "3000"
  ], { cwd: workspace });
  assert.equal(previewStart.action, "preview.start");
  assert.equal(previewStart.params?.cwd, path.join(workspace, relativeCwd));

  const serviceStart = await captureHarnessAction([
    "service", "start",
    "--template", "redis",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(serviceStart.action, "service.start");
  assert.equal(serviceStart.params?.cwd, path.join(workspace, relativeCwd));

  const stackStart = await captureHarnessAction([
    "stack", "start",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(stackStart.action, "stack.start");
  assert.equal(stackStart.params?.cwd, path.join(workspace, relativeCwd));

  const desktopStart = await captureHarnessAction([
    "desktop", "use", "start",
    "--command", "echo ok",
    "--cwd", relativeCwd
  ], { cwd: workspace });
  assert.equal(desktopStart.action, "desktop.use.start");
  assert.equal(desktopStart.params?.cwd, path.join(workspace, relativeCwd));
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
