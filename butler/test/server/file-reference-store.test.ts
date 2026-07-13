import assert from "node:assert/strict";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileReferenceStore, migrateLegacyReferenceStore } from "../../src/server/file-store.js";

test("uploaded reference files are durable and immutable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-file-reference-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new FileReferenceStore(root);
  await store.load();
  const created = await store.createFromBuffer({
    name: "report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("durable input")
  });
  const filePath = store.getFilePath(created.id);
  assert.ok(filePath);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o444);
  assert.equal(await fs.readFile(filePath, "utf8"), "durable input");

  const indexPath = path.join(root, "index.json");
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8")) as Array<{ filePath: string }>;
  persisted[0]!.filePath = `/artifacts/manor-files/files/${path.basename(filePath)}`;
  await fs.writeFile(indexPath, JSON.stringify(persisted), "utf8");

  const reloaded = new FileReferenceStore(root);
  await reloaded.load();
  assert.deepEqual(reloaded.get(created.id), created);
  assert.equal(reloaded.getFilePath(created.id), filePath);
  await assert.rejects(fs.access(filePath, fsConstants.W_OK));
});

test("legacy durable uploads migrate into the immutable input store", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-file-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyDir = path.join(root, "artifacts", "manor-files");
  const targetDir = path.join(root, "inputs", "manor-files");
  const legacy = new FileReferenceStore(legacyDir);
  await legacy.load();
  const created = await legacy.createFromBuffer({
    name: "existing.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("existing upload")
  });

  await migrateLegacyReferenceStore(legacyDir, targetDir);
  const migrated = new FileReferenceStore(targetDir);
  await migrated.load();
  const migratedPath = migrated.getFilePath(created.id);
  assert.ok(migratedPath?.startsWith(path.join(targetDir, "files")));
  assert.equal(await fs.readFile(migratedPath, "utf8"), "existing upload");
  assert.equal((await fs.stat(migratedPath)).mode & 0o777, 0o444);
});

test("concurrent file uploads persist every reference", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-file-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileReferenceStore(root);
  await store.load();

  await Promise.all(Array.from({ length: 12 }, (_, index) => store.createFromBuffer({
    name: `file-${index}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`content-${index}`)
  })));

  const reloaded = new FileReferenceStore(root);
  await reloaded.load();
  assert.equal(reloaded.list(20).length, 12);
});

test("derived file versions are immutable and allocate monotonic lineage versions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manor-file-versions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileReferenceStore(root);
  await store.load();
  const source = await store.createFromBuffer({ name: "source.pdf", mimeType: "application/pdf", buffer: Buffer.from("source") });
  const [second, third] = await Promise.all([
    store.createVersionFromBuffer({ name: "second.pdf", mimeType: "application/pdf", buffer: Buffer.from("second"), sourceReferenceId: source.id }),
    store.createVersionFromBuffer({ name: "third.pdf", mimeType: "application/pdf", buffer: Buffer.from("third"), sourceReferenceId: source.id })
  ]);
  assert.deepEqual(new Set([second.version, third.version]), new Set([2, 3]));
  assert.equal(second.sourceReferenceId, source.id);
  assert.equal(third.sourceReferenceId, source.id);
  assert.equal(await fs.readFile(store.getFilePath(source.id)!, "utf8"), "source");
  await assert.rejects(fs.access(store.getFilePath(second.id)!, fsConstants.W_OK));
  const latest = second.version === 3 ? second : third;
  await store.delete(latest.id);
  const fourth = await store.createVersionFromBuffer({ name: "fourth.pdf", mimeType: "application/pdf", buffer: Buffer.from("fourth"), sourceReferenceId: source.id });
  assert.equal(fourth.version, 4);
});
