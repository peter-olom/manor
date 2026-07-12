import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildButlerProjectTools } from "../../src/server/butler-agent-project-tools.js";
import type { ButlerAgentToolAccess } from "../../src/server/butler-agent-tool-access.js";
import type { ProjectArtifactView, ProjectPolicyView } from "../../src/server/types.js";

type CapturedTool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    details?: Record<string, unknown>;
  }>;
};

test("artifact and policy tools honor an explicit project id over cwd inference", async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "manor-butler-project-tools-"));
  try {
    const definitions: CapturedTool[] = [];
    let inferredProjectCalls = 0;
    let artifact: ProjectArtifactView | null = null;
    let policy: ProjectPolicyView | null = null;
    const access = {
      defineButlerTool: (definition: CapturedTool) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      resolveWorkspaceProject: () => {
        inferredProjectCalls += 1;
        return { id: "cwd-project", label: "Cwd project" };
      },
      store: {
        getThread: () => null,
        upsertProjectArtifact: (next: ProjectArtifactView) => {
          artifact = next;
        },
        getProjectPolicy: () => null,
        upsertProjectPolicy: (next: ProjectPolicyView) => {
          policy = next;
        }
      }
    } as unknown as ButlerAgentToolAccess;

    buildButlerProjectTools(access, artifactsDir);
    const saveArtifact = definitions.find((definition) => definition.name === "save_project_artifact");
    const rememberPolicy = definitions.find((definition) => definition.name === "remember_project_policy");
    assert.ok(saveArtifact);
    assert.ok(rememberPolicy);

    await saveArtifact.execute("tool-call-1", {
      projectId: "explicit-project",
      cwd: "/repos/cwd-project",
      title: "Seed",
      text: "seed data"
    });
    await rememberPolicy.execute("tool-call-2", {
      projectId: "explicit-project",
      cwd: "/repos/cwd-project",
      title: "Use seed",
      instruction: "Reuse the stored seed."
    });

    assert.equal(artifact?.projectId, "explicit-project");
    assert.equal(artifact?.projectLabel, "explicit-project");
    assert.equal(policy?.projectId, "explicit-project");
    assert.equal(policy?.projectLabel, "explicit-project");
    assert.equal(inferredProjectCalls, 0);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("cross-project artifact listings identify each project", async () => {
  const definitions: CapturedTool[] = [];
  const artifact = {
    id: "artifact-1",
    projectId: "alpha",
    projectLabel: "Alpha",
    kind: "report",
    title: "Report",
    description: null,
    fileName: "report.txt",
    filePath: "/artifacts/report.txt",
    contentType: "text/plain",
    sizeBytes: 6,
    tags: [],
    metadata: {},
    source: { kind: "inline", url: null, createdByThreadId: null, checksumSha256: null },
    textPreview: "report",
    createdAt: 1,
    updatedAt: 1
  } satisfies ProjectArtifactView;
  const access = {
    defineButlerTool: (definition: CapturedTool) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    store: {
      pruneMissingProjectArtifacts: async () => 0,
      listProjectArtifacts: () => [artifact]
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerProjectTools(access, "/artifacts");
  const listArtifacts = definitions.find((definition) => definition.name === "list_project_artifacts");
  assert.ok(listArtifacts);
  const result = await listArtifacts.execute("tool-call-1", {});
  assert.match(result.content[0]?.text ?? "", /project=alpha/);
});

test("share project file accepts files already in Manor artifact storage", async () => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "manor-share-project-file-"));
  try {
    const sourceFilePath = path.join(artifactsDir, "existing.txt");
    await writeFile(sourceFilePath, "existing artifact", "utf8");
    const definitions: CapturedTool[] = [];
    let stored: ProjectArtifactView | null = null;
    const access = {
      defineButlerTool: (definition: CapturedTool) => {
        definitions.push(definition);
        return definition;
      },
      getToolUiEffects: () => [],
      store: {
        getThread: () => null,
        upsertProjectArtifact: (artifact: ProjectArtifactView) => { stored = artifact; }
      }
    } as unknown as ButlerAgentToolAccess;

    buildButlerProjectTools(access, artifactsDir);
    const shareFile = definitions.find((definition) => definition.name === "share_project_file");
    assert.ok(shareFile);
    const result = await shareFile.execute("tool-call-1", {
      sourceFilePath,
      projectId: "alpha",
      title: "Existing artifact"
    });
    assert.match(result.content[0]?.text ?? "", /Download:/);
    assert.equal(stored?.projectId, "alpha");
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("memory retrieval rejects conflicting project and job scopes", async () => {
  const definitions: CapturedTool[] = [];
  const access = {
    defineButlerTool: (definition: CapturedTool) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    store: {
      getThread: () => ({
        executionContract: { projectId: "alpha" },
        supervisor: { projectId: "alpha" }
      }),
      getJobMemory: () => ({ projectId: "alpha" })
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerProjectTools(access, "/artifacts");
  const retrieveMemory = definitions.find((definition) => definition.name === "retrieve_memory");
  assert.ok(retrieveMemory);
  await assert.rejects(
    retrieveMemory.execute("tool-call-1", { projectId: "beta", threadId: "thread-alpha" }),
    /does not match job thread-alpha.*project alpha/
  );
});

test("policy invocation is context-only and rejects cross-project services", async () => {
  const definitions: CapturedTool[] = [];
  const policy = {
    id: "policy-alpha",
    projectId: "alpha",
    projectLabel: "Alpha",
    title: "Use the seed",
    instruction: "Load the saved seed before planning.",
    artifacts: [],
    triggers: [],
    createdAt: 1,
    updatedAt: 1
  } satisfies ProjectPolicyView;
  const access = {
    defineButlerTool: (definition: CapturedTool) => {
      definitions.push(definition);
      return definition;
    },
    getToolUiEffects: () => [],
    runtimeBroker: {},
    resolveWorkspaceProject: () => ({ id: "alpha", label: "Alpha" }),
    store: {
      getThread: () => null,
      listProjectPolicies: () => [policy],
      getProjectArtifact: () => null,
      getServiceLease: (serviceId: string) => serviceId === "service-beta" ? { id: serviceId, projectId: "beta" } : null
    }
  } as unknown as ButlerAgentToolAccess;

  buildButlerProjectTools(access, "/artifacts");
  const invokePolicy = definitions.find((definition) => definition.name === "invoke_project_policy");
  assert.ok(invokePolicy);
  assert.match(invokePolicy.description ?? "", /does not execute commands or mutate a service/);
  await assert.rejects(
    invokePolicy.execute("tool-call-1", { selector: "policy-alpha", projectId: "alpha", serviceId: "service-beta" }),
    /belongs to project beta, not alpha/
  );
  const result = await invokePolicy.execute("tool-call-2", { selector: "policy-alpha", projectId: "alpha" });
  assert.match(result.content[0]?.text ?? "", /No commands or service changes were executed/);
  assert.equal((result.details?.result as { mode?: string; executed?: boolean }).mode, "context_only");
  assert.equal((result.details?.result as { mode?: string; executed?: boolean }).executed, false);
});
