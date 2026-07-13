import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSystemPrompt } from "../../src/server/butler-agent-helpers.js";
import { buildButlerFilesystemTools, inspectReadOnlyFilesystem } from "../../src/server/butler-agent-filesystem-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import { BUTLER_TOOL_CATALOG } from "../../src/server/butler-agent-tool-catalog.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "manor-fs-tool-"));
  await mkdir(path.join(root, "repo", "nested"), { recursive: true });
  await writeFile(path.join(root, "repo", "README.md"), "hello");
  await writeFile(path.join(root, "repo", "nested", "keep.txt"), "nested");
  return root;
}

test("inspectReadOnlyFilesystem confines paths to approved roots", async () => {
  const root = await fixture();
  await assert.rejects(
    inspectReadOnlyFilesystem({ operation: "stat", path: tmpdir() }, { approvedRoots: [root] }),
    /outside approved read-only roots/
  );

  const outside = await mkdtemp(path.join(tmpdir(), "manor-fs-outside-"));
  await symlink(outside, path.join(root, "outside-link"));
  await assert.rejects(
    inspectReadOnlyFilesystem({ operation: "list", path: path.join(root, "outside-link") }, { approvedRoots: [root] }),
    /resolves outside approved read-only root/
  );
});

test("inspectReadOnlyFilesystem supports stat, list, and bounded find", async () => {
  const root = await fixture();

  const stat = await inspectReadOnlyFilesystem({ operation: "stat", path: path.join(root, "repo", "README.md") }, { approvedRoots: [root] });
  assert.match(stat.text, /file\s+\d+\s+.*README\.md/);

  const listed = await inspectReadOnlyFilesystem({ operation: "list", path: path.join(root, "repo"), type: "directory" }, { approvedRoots: [root] });
  assert.match(listed.text, /directory\s+\d+\s+.*nested/);
  assert.doesNotMatch(listed.text, /README\.md/);

  const shallow = await inspectReadOnlyFilesystem({ operation: "find", path: root, maxDepth: 1, nameContains: "keep" }, { approvedRoots: [root] });
  assert.doesNotMatch(shallow.text, /keep\.txt/);

  const deep = await inspectReadOnlyFilesystem({ operation: "find", path: root, maxDepth: 3, nameContains: "keep" }, { approvedRoots: [root] });
  assert.match(deep.text, /keep\.txt/);
});

test("inspectReadOnlyFilesystem reads bounded AGENTS.md text and rejects binary content", async () => {
  const root = await fixture();
  const agentsPath = path.join(root, "repo", "AGENTS.md");
  const binaryPath = path.join(root, "repo", "binary.txt");
  await writeFile(agentsPath, "# AGENTS.md\n\nUse Docker for local development.\n");
  await writeFile(binaryPath, Buffer.from([65, 0, 66]));

  const full = await inspectReadOnlyFilesystem({ operation: "read", path: agentsPath }, { approvedRoots: [root] });
  assert.equal(full.text, "# AGENTS.md\n\nUse Docker for local development.\n");
  assert.equal(full.details.truncated, false);

  const bounded = await inspectReadOnlyFilesystem({ operation: "read", path: agentsPath, maxBytes: 12 }, { approvedRoots: [root] });
  assert.match(bounded.text, /^# AGENTS\.md\n/);
  assert.match(bounded.text, /truncated at 12 bytes/);
  assert.equal(bounded.details.truncated, true);
  await assert.rejects(
    inspectReadOnlyFilesystem({ operation: "read", path: binaryPath }, { approvedRoots: [root] }),
    /binary data/
  );
});

test("inspectReadOnlyFilesystem reads the verified descriptor when the selected path is swapped", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), "manor-fs-swap-outside-"));
  const agentsPath = path.join(root, "repo", "AGENTS.md");
  const openedPath = path.join(root, "repo", "opened-AGENTS.md");
  const outsidePath = path.join(outside, "AGENTS.md");
  await writeFile(agentsPath, "# Trusted AGENTS.md\n");
  await writeFile(outsidePath, "# Outside content\n");

  const result = await inspectReadOnlyFilesystem(
    { operation: "read", path: agentsPath },
    {
      approvedRoots: [root],
      beforeRead: async () => {
        await rename(agentsPath, openedPath);
        await symlink(outsidePath, agentsPath);
      }
    }
  );

  assert.equal(result.text, "# Trusted AGENTS.md\n");
  assert.doesNotMatch(result.text, /Outside content/);
});

test("Butler registers the read-only filesystem tool", async () => {
  const definitions: Array<{
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const access = {
    defineButlerTool: (definition: (typeof definitions)[number]) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => []
  } as unknown as ButlerAgentToolAccess;

  buildButlerFilesystemTools(access);
  const tool = definitions.find((definition) => definition.name === "inspect_filesystem");
  assert.ok(tool);

  const root = await fixture();
  process.env.MANOR_BUTLER_FS_INSPECTION_ROOTS = root;
  try {
    const result = await tool.execute("tool-call-1", { operation: "list", path: path.join(root, "repo"), limit: 5 });
    assert.match(result.content[0]?.text ?? "", /README\.md/);
  } finally {
    delete process.env.MANOR_BUTLER_FS_INSPECTION_ROOTS;
  }
});

test("Butler prompt and catalog guide safe fs inspection and same-context follow-ups", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-fs-prompt-"));
  const store = new ButlerStateStore(path.join(dir, "state.json"));
  const prompt = buildSystemPrompt(store, "No callbacks.");

  assert.match(prompt, /Use inspect_filesystem to read selected UTF-8 text files/);
  assert.match(prompt, /default to message_job when it is the same workspace and task context/);
  assert.match(prompt, /surface and record that reason when you delegate anew/);
  assert.ok(BUTLER_TOOL_CATALOG.some((tool) => tool.name === "inspect_filesystem"));
});
