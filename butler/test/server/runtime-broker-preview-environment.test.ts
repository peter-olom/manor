import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewUserDirectoryCommand,
  buildPreviewUserEnvironment,
  createPreviewImagePreparer,
  previewImagePreparationKey
} from "../../../docker/runtime-broker/broker-preview-environment.mjs";

const genericKeys = [
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR"
];

test("preview user environment is generic, private, and lease unique", () => {
  const first = buildPreviewUserEnvironment("lease-one", { APP_MODE: "demo" });
  const second = buildPreviewUserEnvironment("lease-two");

  assert.equal(first.APP_MODE, "demo");
  assert.notEqual(first.HOME, second.HOME);
  for (const key of genericKeys) {
    assert.match(first[key], /^\/tmp\/manor-preview-users\/[a-f0-9]{24}/);
    assert.notEqual(first[key], second[key]);
  }
  assert.deepEqual(Object.keys(first).sort(), [...genericKeys, "APP_MODE"].sort());
  assert.throws(() => buildPreviewUserEnvironment("lease", { HOME: "/shared" }), /managed by Manor: HOME/);

  const command = buildPreviewUserDirectoryCommand(first);
  assert.match(command, /^umask 077; mkdir -p /);
  assert.match(command, /chmod 700/);
});

test("preview image preparation key is deterministic and input sensitive", () => {
  const first = previewImagePreparationKey("sha256:base", "install tool", "custom", ["b.test", "a.test"]);
  const reordered = previewImagePreparationKey("sha256:base", "install tool", "custom", ["a.test", "b.test"]);
  const changed = previewImagePreparationKey("sha256:base", "install another", "custom", ["a.test", "b.test"]);

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

function createFakeDocker(options: { statusCode?: number; wait?: Promise<unknown> } = {}) {
  const calls = {
    containers: [] as Array<Record<string, unknown>>,
    commits: 0,
    removes: 0,
    networks: 0,
    networkRemoves: 0,
    imageRemoves: 0,
    commitChanges: [] as string[]
  };
  let cachedImageId = "";
  const docker = {
    getImage(name: string) {
      return {
        async inspect() {
          if (name === "base:latest") return { Id: "sha256:base" };
          if (cachedImageId) return { Id: cachedImageId };
          throw new Error("missing");
        },
        async remove() {
          calls.imageRemoves += 1;
        }
      };
    },
    async listContainers() {
      return [];
    },
    async listNetworks() {
      return [];
    },
    async listImages() {
      return [];
    },
    async createNetwork() {
      calls.networks += 1;
      return {
        async remove() {
          calls.networkRemoves += 1;
        }
      };
    },
    async createContainer(config: Record<string, unknown>) {
      calls.containers.push(config);
      return {
        async start() {},
        wait: () => options.wait ?? Promise.resolve({ StatusCode: options.statusCode ?? 0 }),
        async logs() {
          return Buffer.from("setup failed");
        },
        async commit(options: { changes?: string[] }) {
          calls.commits += 1;
          calls.commitChanges = options.changes ?? [];
          cachedImageId = "sha256:prepared";
          return { Id: cachedImageId };
        },
        async remove() {
          calls.removes += 1;
        }
      };
    }
  };
  return { docker, calls };
}

function createPreparer(fake: ReturnType<typeof createFakeDocker>, timeout = 1000) {
  return createPreviewImagePreparer({
    docker: fake.docker,
    ensureImage: async () => {},
    collectDockerLogs: async (value: Buffer) => value.toString("utf8"),
    ensureNetworkConnection: async () => {},
    disconnectNetworkConnection: async () => {},
    previewEgressContainerName: "preview-egress",
    preparationTimeoutMs: timeout
  });
}

const preparationInput = {
  baseImage: "base:latest",
  setupCommand: "arbitrary setup command",
  egressProfile: "internet",
  egressDomains: [] as string[],
  proxyEnv: [] as string[]
};

test("image preparation is isolated, root-only, cached, and coalesced", async () => {
  const fake = createFakeDocker();
  const prepare = createPreparer(fake);
  const [first, concurrent] = await Promise.all([prepare(preparationInput), prepare(preparationInput)]);
  const cached = await prepare(preparationInput);

  assert.equal(first, "sha256:prepared");
  assert.equal(concurrent, first);
  assert.equal(cached, first);
  assert.equal(fake.calls.containers.length, 1);
  assert.equal(fake.calls.commits, 1);
  assert.equal(fake.calls.removes, 1);
  assert.equal(fake.calls.networks, 1);
  assert.equal(fake.calls.networkRemoves, 1);
  assert.ok(fake.calls.commitChanges.includes('CMD ["/bin/sh"]'));
  assert.ok(fake.calls.commitChanges.includes("USER 1001:1001"));
  assert.ok(fake.calls.commitChanges.some((change) => change.startsWith("ENV HTTP_PROXY=")));

  const config = fake.calls.containers[0] as {
    User: string;
    Entrypoint: unknown[];
    Cmd: string[];
    Env: string[];
    HostConfig: {
      Mounts: unknown[];
      CapDrop: string[];
      CapAdd: string[];
      Memory: number;
      NanoCpus: number;
      PidsLimit: number;
      SecurityOpt: string[];
    };
  };
  assert.equal(config.User, "0:0");
  assert.deepEqual(config.Entrypoint, []);
  assert.deepEqual(config.Cmd, ["sh", "-lc", preparationInput.setupCommand]);
  assert.deepEqual(config.Env, []);
  assert.deepEqual(config.HostConfig.Mounts, []);
  assert.deepEqual(config.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(config.HostConfig.CapAdd, ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "MKNOD", "SETFCAP", "SETGID", "SETUID"]);
  assert.equal(config.HostConfig.Memory, 4 * 1024 * 1024 * 1024);
  assert.equal(config.HostConfig.NanoCpus, 4_000_000_000);
  assert.equal(config.HostConfig.PidsLimit, 1024);
  assert.deepEqual(config.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
});

test("failed or timed-out preparation cleans up and never commits", async () => {
  const failed = createFakeDocker({ statusCode: 9 });
  await assert.rejects(createPreparer(failed)(preparationInput), /setup failed/);
  assert.equal(failed.calls.commits, 0);
  assert.equal(failed.calls.removes, 1);
  assert.equal(failed.calls.networkRemoves, 1);

  const timedOut = createFakeDocker({ wait: new Promise(() => {}) });
  await assert.rejects(createPreparer(timedOut, 5)(preparationInput), /timed out/);
  assert.equal(timedOut.calls.commits, 0);
  assert.equal(timedOut.calls.removes, 1);
  assert.equal(timedOut.calls.networkRemoves, 1);
});

test("cancelling the final consumer stops and cleans preparation", async () => {
  const fake = createFakeDocker({ wait: new Promise(() => {}) });
  const prepare = createPreparer(fake);
  let cancelled = false;
  const pending = prepare({ ...preparationInput, isCancelled: () => cancelled });
  setTimeout(() => {
    cancelled = true;
  }, 5);

  await assert.rejects(pending, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.calls.commits, 0);
  assert.equal(fake.calls.removes, 1);
  assert.equal(fake.calls.networkRemoves, 1);
});

test("maintenance disconnects proxy egress before removing stale preparation networks", async () => {
  const events: string[] = [];
  const docker = {
    async listContainers() { return []; },
    async listNetworks() {
      return [{
        Id: "stale-network-id",
        Name: "stale-preparation-network",
        Created: new Date(0).toISOString(),
        Labels: {
          "manor.runtime-kind": "preview-image-preparation",
          "manor.broker-instance": "old-broker"
        }
      }];
    },
    async listImages() { return []; },
    getNetwork(id: string) {
      assert.equal(id, "stale-network-id");
      return { async remove() { events.push("remove"); } };
    }
  };
  const prepare = createPreviewImagePreparer({
    docker,
    ensureImage: async () => {},
    collectDockerLogs: async () => "",
    ensureNetworkConnection: async () => {},
    disconnectNetworkConnection: async (networkName: string, containerName: string) => {
      assert.equal(networkName, "stale-preparation-network");
      assert.equal(containerName, "preview-egress");
      events.push("disconnect");
    },
    previewEgressContainerName: "preview-egress",
    brokerInstanceId: "current-broker"
  });

  await prepare.maintain();
  assert.deepEqual(events, ["disconnect", "remove"]);
});
