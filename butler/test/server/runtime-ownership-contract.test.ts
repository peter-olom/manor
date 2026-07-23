import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../../../compose.yml", import.meta.url);
const butlerDockerfilePath = new URL("../../../docker/butler/Dockerfile", import.meta.url);
const workerDockerfilePath = new URL("../../../docker/worker/Dockerfile", import.meta.url);
const butlerStartPath = new URL("../../../docker/butler/start.sh", import.meta.url);
const workerStartPath = new URL("../../../docker/worker/start.sh", import.meta.url);
const ownershipInitPath = new URL("../../../docker/worker/ownership-init.sh", import.meta.url);
const brokerPath = new URL("../../../docker/runtime-broker/broker.mjs", import.meta.url);
const brokerCorePath = new URL("../../../docker/runtime-broker/broker-core.mjs", import.meta.url);
const brokerStoragePath = new URL("../../../docker/runtime-broker/broker-storage.mjs", import.meta.url);

function serviceSection(compose: string, name: string, nextName: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(`\n  ${nextName}:\n`, start + 1);
  assert.ok(start >= 0 && end > start, `missing ${name} service`);
  return compose.slice(start, end);
}

test("Butler and Worker use named non-root users with one appliance UID", async () => {
  const [compose, butlerDockerfile, workerDockerfile, butlerStart, workerStart] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(butlerDockerfilePath, "utf8"),
    readFile(workerDockerfilePath, "utf8"),
    readFile(butlerStartPath, "utf8"),
    readFile(workerStartPath, "utf8")
  ]);
  const butler = serviceSection(compose, "butler", "butler-executor");
  const executor = serviceSection(compose, "butler-executor", "ollama");
  const worker = serviceSection(compose, "worker", "egress");

  assert.match(butlerDockerfile, /useradd --uid 1001 --gid butler .* butler/);
  assert.match(workerDockerfile, /useradd --uid 1001 --gid worker .* worker/);
  assert.match(butlerDockerfile, /^USER butler$/m);
  assert.match(workerDockerfile, /^USER worker$/m);
  assert.match(butler, /user: butler/);
  assert.match(executor, /user: worker/);
  assert.match(worker, /user: worker/);
  assert.match(butlerStart, /Required directory is not writable by the Butler user/);
  assert.match(workerStart, /Worker must run as the non-root worker user/);
});

test("a constrained one-shot initializer repairs only managed actor volumes", async () => {
  const [compose, ownershipInit] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(ownershipInitPath, "utf8")
  ]);
  const initializer = serviceSection(compose, "ownership-init", "butler");

  assert.match(initializer, /user: "0:0"/);
  assert.match(initializer, /network_mode: none/);
  assert.match(initializer, /restart: "no"/);
  assert.match(initializer, /no-new-privileges:true/);
  assert.match(initializer, /butler-state:\/managed\/butler-state/);
  assert.match(initializer, /worker-pi:\/managed\/worker-pi/);
  assert.match(initializer, /repos:\/managed\/repos/);
  assert.match(initializer, /artifacts:\/managed\/artifacts/);
  assert.doesNotMatch(initializer, /host-controller-state|runtime-broker-state|playwright-state|ollama-state/);
  assert.match(ownershipInit, /find "\$\{root\}" -xdev/);
  assert.match(ownershipInit, /chown -h "\$\{appliance_uid\}:\$\{appliance_gid\}"/);

  for (const service of [
    serviceSection(compose, "butler", "butler-executor"),
    serviceSection(compose, "butler-executor", "ollama"),
    serviceSection(compose, "worker", "egress")
  ]) {
    assert.match(service, /ownership-init:\n\s+condition: service_completed_successfully/);
  }
});

test("preview containers and output directories use the Worker identity", async () => {
  const [broker, brokerCore, brokerStorage] = await Promise.all([
    readFile(brokerPath, "utf8"),
    readFile(brokerCorePath, "utf8"),
    readFile(brokerStoragePath, "utf8")
  ]);

  assert.match(broker, /const workspaceUser = await resolveWorkspaceUser\(\)/);
  assert.match(broker, /User: workspaceUser/);
  assert.match(broker, /WorkingDir: "\/tmp"/);
  assert.doesNotMatch(broker, /WorkingDir: runtimeWorktreePath/);
  assert.doesNotMatch(brokerCore, /rm -rf \\"\$DST\\"/);
  assert.match(brokerCore, /mkdir \\"\$DST\\"/);
  assert.match(broker, /"manor\.workspace-user": workspaceUser/);
  assert.doesNotMatch(brokerStorage, /User: "0"/);
  assert.doesNotMatch(brokerStorage, /chmod 0777/);
  assert.match(brokerStorage, /Cmd: \["mkdir", "-p", `\/outputs\/\$\{outputSubpath\}`\]/);
  assert.match(broker, /outputSubpath: lease\.id/);
  assert.doesNotMatch(broker, /outputSubpath: lease\.threadId \|\| lease\.id/);
});
