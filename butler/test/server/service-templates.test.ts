import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ServiceTemplateRegistry } from "../../src/server/service-templates.js";

test("pgvector postgres is available as a built-in service template", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-service-templates-"));
  const registry = new ServiceTemplateRegistry(path.join(root, "templates.json"));
  await registry.load();

  const template = registry.get("pgvector-postgres");
  assert.equal(template?.image, "pgvector/pgvector:pg15");
  assert.equal(template?.defaultPort, 5432);
  assert.equal(template?.connection.uriTemplate, "postgresql://{USERNAME}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}");
});

test("service template registry accepts full specs with defaultPort", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manor-service-templates-"));
  const registry = new ServiceTemplateRegistry(path.join(root, "templates.json"));
  await registry.load();

  const template = await registry.upsert({
    id: "custom-pgvector",
    label: "Custom Pgvector",
    description: "Custom pgvector database",
    runtimeKind: "container",
    engine: "postgres",
    image: "pgvector/pgvector:pg15",
    defaultPort: 5432,
    stackVolumePath: "/var/lib/postgresql/data",
    envDefaults: {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "localdev",
      POSTGRES_DB: "testamy"
    },
    connection: {
      databaseEnv: "POSTGRES_DB",
      usernameEnv: "POSTGRES_USER",
      passwordEnv: "POSTGRES_PASSWORD",
      uriTemplate: "postgresql://{USERNAME}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}"
    }
  });

  assert.equal(template.id, "custom-pgvector");
  assert.equal(template.defaultPort, 5432);
});
