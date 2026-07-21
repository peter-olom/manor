import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../../../compose.yml", import.meta.url);
const butlerDockerfilePath = new URL("../../../docker/butler/Dockerfile", import.meta.url);
const workerDockerfilePath = new URL("../../../docker/worker/Dockerfile", import.meta.url);
const workerStartPath = new URL("../../../docker/worker/start.sh", import.meta.url);
const indexPath = new URL("../../src/server/index.ts", import.meta.url);

test("the Pi Worker uses the shared Worker environment", async () => {
  const [compose, butlerDockerfile, workerDockerfile, workerStart, index] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(butlerDockerfilePath, "utf8"),
    readFile(workerDockerfilePath, "utf8"),
    readFile(workerStartPath, "utf8"),
    readFile(indexPath, "utf8")
  ]);
  const workerComposeStart = compose.indexOf("\n  worker:\n");
  const workerComposeEnd = compose.indexOf("\n  egress:\n", workerComposeStart);
  assert.ok(workerComposeStart >= 0 && workerComposeEnd > workerComposeStart);
  const workerCompose = compose.slice(workerComposeStart, workerComposeEnd);

  assert.match(workerCompose, /MANOR_ROLE: worker/);
  assert.match(workerCompose, /hostname: manor-worker/);
  assert.match(workerCompose, /HOME: \/home\/worker/);
  assert.match(compose, /WORKER_PI_RPC_CLI_PATH: \/usr\/local\/bin\/worker-pi-rpc-proxy\.mjs/);
  assert.match(workerCompose, /WORKER_PI_RPC_SOCKET: \/worker-runtime\/pi-rpc\.sock/);
  assert.match(workerCompose, /PI_CODING_AGENT_DIR: \/worker-pi\/agent/);
  assert.match(workerCompose, /NODE_USE_ENV_PROXY: "1"/);
  assert.match(workerCompose, /restart: unless-stopped/);
  assert.match(compose, /RUNTIME_WORKSPACE_CONTAINER: manor-worker/);
  assert.match(compose, /worker-pi:\/worker-pi/);
  assert.match(compose, /worker-runtime:\/worker-runtime/);
  assert.match(butlerDockerfile, /COPY docker\/butler\/worker-pi-rpc-proxy\.mjs/);
  assert.match(workerDockerfile, /COPY --from=worker-runtime-deps \/opt\/manor\/worker\/node_modules/);
  assert.match(workerDockerfile, /COPY --from=worker-build \/opt\/manor\/worker\/dist\/server/);
  assert.match(workerDockerfile, /worker-pi-rpc-bridge\.mjs/);
  assert.match(workerDockerfile, /useradd --uid 1001 --gid worker --create-home --shell \/bin\/bash worker/);
  assert.match(workerDockerfile, /^USER worker$/m);
  assert.match(workerStart, /node \/opt\/manor\/worker\/worker-pi-rpc-bridge\.mjs/);
  assert.match(index, /workerPiRpcCliPath/);
  assert.match(index, /manageSessionDirectories: workerPiRpcCliPath === null/);
});

test("Butler and Worker share skills while repository writes stay Worker-only", async () => {
  const compose = await readFile(composePath, "utf8");
  const section = (name: string, next?: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    const end = next ? compose.indexOf(`\n  ${next}:\n`, start + 1) : compose.indexOf("\nnetworks:\n", start + 1);
    assert.ok(start >= 0 && end > start, `missing ${name} service`);
    return compose.slice(start, end);
  };
  const butler = section("butler", "butler-executor");
  const executor = section("butler-executor", "ollama");
  const worker = section("worker", "egress");
  const desktop = section("desktop-proof");

  assert.match(butler, /repos:\/repos:ro/);
  assert.match(butler, /skill-registry:\/skills\n/);
  assert.match(butler, /skill-registry:\/home\/butler\/\.pi\/agent\/skills:ro/);
  assert.match(executor, /read_only: true/);
  assert.match(executor, /repos:\/repos:ro/);
  assert.match(executor, /skill-registry:\/skills:ro/);
  assert.match(executor, /butler-scratch:\/scratch/);
  assert.match(executor, /MANOR_HARNESS_SOCKET_PATH: \/butler-executor-runtime\/admission\.sock/);
  assert.match(executor, /- executor-egress/);
  assert.doesNotMatch(executor, /MANOR_BUTLER_BASE_URL|\n\s+- admission\n|\n\s+- internet\n/);
  assert.match(executor, /pids_limit: 256/);
  assert.doesNotMatch(executor, /RUNTIME_BROKER_TOKEN|MANOR_HOST_CONTROLLER_TOKEN|harness-state/);
  assert.match(worker, /skill-registry:\/worker-pi\/agent\/skills:ro/);
  assert.match(worker, /- repos:\/repos\n/);
  assert.match(desktop, /repos:\/repos:ro/);
});
