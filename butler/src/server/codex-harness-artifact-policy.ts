import { normalizeString, normalizeStringArray } from "./codex-harness-helpers.js";
import {
  buildProjectPolicy,
  createProjectArtifactFromText,
  createProjectArtifactFromUrl,
  findProjectPolicyBySelector,
  invokeProjectPolicy,
  normalizeArtifactMetadata,
  resolveProjectPolicyArtifactIds,
  readProjectArtifactContent
} from "./project-artifacts-policies.js";
import type { RuntimeBrokerClient } from "./runtime-broker-client.js";
import type { ButlerStateStore } from "./state-store.js";
import type { CodexThreadRecord } from "./types.js";

function hasOwnField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export async function handleHarnessArtifactPolicyAction(input: {
  action: string;
  threadId: string;
  cwd: string;
  artifactsDir: string;
  thread: CodexThreadRecord;
  store: ButlerStateStore;
  runtimeBroker: RuntimeBrokerClient;
  params: Record<string, unknown>;
  resolveWorkspaceProject: (cwd: string, thread: CodexThreadRecord) => { id: string; label: string };
}): Promise<{ text: string; data?: Record<string, unknown> } | null> {
  const { action, threadId, cwd, artifactsDir, thread, store, runtimeBroker, params, resolveWorkspaceProject } = input;
  if (action === "artifact.list") {
    const project = resolveWorkspaceProject(cwd, thread);
    const artifacts = store.listProjectArtifacts(project.id);
    return {
      text:
        artifacts.length === 0
          ? "No project artifacts are stored."
          : artifacts
              .map(
                (artifact, index) =>
                  `${index + 1}. ${artifact.id} | ${artifact.kind} | ${artifact.title} | ${artifact.fileName} | ${artifact.sizeBytes} bytes`
              )
              .join("\n"),
      data: { artifacts }
    };
  }
  if (action === "artifact.read") {
    const project = resolveWorkspaceProject(cwd, thread);
    const artifact = store.getProjectArtifact(project.id, normalizeString(params.artifactId));
    if (!artifact) {
      throw new Error("Artifact not found");
    }
    const content = await readProjectArtifactContent(artifact);
    return {
      text: [
        `${artifact.title} | ${artifact.kind} | ${artifact.fileName} | ${artifact.sizeBytes} bytes`,
        content.content ? content.content : "Binary or non-text artifact."
      ].join("\n\n"),
      data: { artifact, content: content.content, contentTruncated: content.truncated }
    };
  }
  if (action === "artifact.save_text") {
    const title = normalizeString(params.title);
    const text = typeof params.text === "string" ? params.text : "";
    if (!title || !text.trim()) {
      throw new Error("artifact.save_text requires title and text");
    }
    const project = resolveWorkspaceProject(cwd, thread);
    const artifact = await createProjectArtifactFromText({
      artifactsDir,
      projectId: project.id,
      projectLabel: project.label,
      threadId,
      kind:
        params.kind === "seed" ||
        params.kind === "reference" ||
        params.kind === "download" ||
        params.kind === "research" ||
        params.kind === "report"
          ? params.kind
          : "other",
      title,
      description: normalizeString(params.description) || null,
      fileName: normalizeString(params.fileName) || null,
      contentType: normalizeString(params.contentType) || null,
      text,
      tags: normalizeStringArray(params.tags),
      metadata: normalizeArtifactMetadata(params.metadata)
    });
    store.upsertProjectArtifact(artifact);
    store.addEvent(threadId, "harness/artifact/save", `Saved artifact ${artifact.title}`);
    return {
      text: `Saved ${artifact.title} as a durable project artifact.`,
      data: { artifact }
    };
  }
  if (action === "artifact.download") {
    const title = normalizeString(params.title);
    const url = normalizeString(params.url);
    if (!title || !url) {
      throw new Error("artifact.download requires title and url");
    }
    const project = resolveWorkspaceProject(cwd, thread);
    const artifact = await createProjectArtifactFromUrl({
      artifactsDir,
      projectId: project.id,
      projectLabel: project.label,
      threadId,
      kind:
        params.kind === "seed" ||
        params.kind === "reference" ||
        params.kind === "download" ||
        params.kind === "research" ||
        params.kind === "report"
          ? params.kind
          : "download",
      title,
      description: normalizeString(params.description) || null,
      url,
      fileName: normalizeString(params.fileName) || null,
      contentType: normalizeString(params.contentType) || null,
      tags: normalizeStringArray(params.tags),
      metadata: normalizeArtifactMetadata(params.metadata)
    });
    store.upsertProjectArtifact(artifact);
    store.addEvent(threadId, "harness/artifact/download", `Downloaded artifact ${artifact.title}`);
    return {
      text: `Downloaded ${artifact.title} into durable project storage.`,
      data: { artifact }
    };
  }
  if (action === "policy.list") {
    const project = resolveWorkspaceProject(cwd, thread);
    const policies = store.listProjectPolicies(project.id);
    return {
      text:
        policies.length === 0
          ? "No project policies are stored."
          : policies
              .map(
                (policy, index) =>
                  `${index + 1}. ${policy.id} | ${policy.title} | triggers=${policy.triggers.join("|") || "none"} | artifacts=${policy.artifacts.join("|") || "none"}`
              )
              .join("\n"),
      data: { policies }
    };
  }
  if (action === "policy.remember") {
    const title = normalizeString(params.title);
    const instruction = normalizeString(params.instruction);
    if (!title || !instruction) {
      throw new Error("policy.remember requires title and instruction");
    }
    const project = resolveWorkspaceProject(cwd, thread);
    const policyId = normalizeString(params.policyId) || null;
    const existing = policyId ? store.getProjectPolicy(project.id, policyId) : null;
    const artifacts = resolveProjectPolicyArtifactIds({
      store,
      projectId: project.id,
      artifactIds: hasOwnField(params, "artifacts") ? normalizeStringArray(params.artifacts) : undefined
    });
    const policy = buildProjectPolicy({
      projectId: project.id,
      projectLabel: project.label,
      title,
      instruction,
      artifacts,
      triggers: hasOwnField(params, "triggers") ? normalizeStringArray(params.triggers) : undefined,
      policyId,
      existing
    });
    store.upsertProjectPolicy(policy);
    store.addEvent(threadId, "harness/policy/remember", `Saved policy ${policy.title}`);
    return {
      text: `Saved project policy ${policy.title}.`,
      data: { policy }
    };
  }
  if (action === "policy.invoke") {
    const selector = normalizeString(params.selector);
    if (!selector) {
      throw new Error("policy.invoke requires selector");
    }
    const project = resolveWorkspaceProject(cwd, thread);
    const policy = findProjectPolicyBySelector({ store, projectId: project.id, selector });
    if (!policy) {
      throw new Error("Policy not found");
    }
    const serviceId = normalizeString(params.serviceId);
    const service = serviceId ? store.getServiceLease(serviceId) ?? null : null;
    const stack = service?.stackId ? store.getStackLease(service.stackId) ?? null : null;
    const result = await invokeProjectPolicy({
      store,
      runtimeBroker,
      policy,
      service,
      stack
    });
    return {
      text: result.message,
      data: { policy, result }
    };
  }
  return null;
}
