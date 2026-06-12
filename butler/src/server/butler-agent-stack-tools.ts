import crypto from "node:crypto";

import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";
import { normalizeStackStorageMode } from "./stack-storage.js";

function normalizeLeaseTtlMs(leaseTtlMinutes: unknown): number | null {
  const numeric = typeof leaseTtlMinutes === "number" ? leaseTtlMinutes : Number(leaseTtlMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(60_000, Math.trunc(numeric * 60_000));
}

function resolveStickyFlag(input: { sticky?: boolean; pinned?: boolean }): boolean | undefined {
  if (typeof input.sticky === "boolean") {
    return input.sticky;
  }
  if (typeof input.pinned === "boolean") {
    return input.pinned;
  }
  return undefined;
}

function withRequestedLeaseLifecycle<T extends object>(
  lease: T,
  input: { sticky?: boolean; pinned?: boolean; leaseTtlMinutes?: number }
): T & { pinned?: boolean; leaseTtlMs?: number | null } {
  const pinned = resolveStickyFlag(input);
  const leaseTtlMs = normalizeLeaseTtlMs(input.leaseTtlMinutes);
  return {
    ...lease,
    ...(typeof pinned === "boolean" ? { pinned } : {}),
    ...(leaseTtlMs !== null ? { leaseTtlMs } : {})
  };
}

function formatLeaseLifecycle(lease: {
  pinned?: boolean;
  lifecycleState?: string;
  leaseTtlMs?: number | null;
  expiresAt?: number | null;
} & object): string {
  const state = lease.pinned ? "sticky" : lease.lifecycleState ?? "active";
  const ttlMinutes =
    typeof lease.leaseTtlMs === "number" && Number.isFinite(lease.leaseTtlMs)
      ? Math.max(1, Math.round(lease.leaseTtlMs / 60_000))
      : null;
  const expiry = typeof lease.expiresAt === "number" && Number.isFinite(lease.expiresAt) ? ` expires=${new Date(lease.expiresAt).toISOString()}` : "";
  return `lease=${state}${ttlMinutes ? ` ttl=${ttlMinutes}m` : ""}${expiry}`;
}

export function buildButlerStackTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  return [
    access.defineButlerTool({
      name: "prepare_worktree",
      label: "Prepare worktree",
      description: "Create an explicitly requested isolated branch and worktree for one repo task.",
      promptSnippet: "prepare_worktree: use this only when the operator explicitly wants branch or worktree isolation.",
      parameters: Type.Object({
        cwd: Type.String(),
        task: Type.String({ minLength: 1 })
      }),
      uiEffects: access.getToolUiEffects("prepare_worktree"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { cwd: string; task: string };
        const workspace = await access.prepareDelegationWorkspace(typedParams.task, typedParams.cwd);
        return {
          content: [
            {
              type: "text",
              text: workspace.branchName
                ? `Prepared worktree ${workspace.cwd} on branch ${workspace.branchName}.`
                : `No git worktree was needed. Using ${workspace.cwd}.`
            }
          ],
          details: workspace
        };
      }
    }),
    access.defineButlerTool({
      name: "list_stacks",
      label: "List stacks",
      description: "List the active stack leases and their isolated networks.",
      promptSnippet: "list_stacks: inspect stack-backed environments before creating another multi-container runtime.",
      parameters: Type.Object({}),
      uiEffects: access.getToolUiEffects("list_stacks"),
      execute: async () => {
        const stacks = access.store.listStackLeases();
        const text =
          stacks.length === 0
            ? "No stack leases are active."
            : stacks
                .map(
                  (stack, index) =>
                    `${index + 1}. ${stack.title} | thread=${stack.threadId ?? "(none)"} | status=${stack.status} | ${formatLeaseLifecycle(stack)} | network=${stack.networkName} | ${access.describeStackStorage(stack)} | previews=${stack.previewIds.length} | services=${stack.serviceIds.length}`
                )
                .join("\n");
        return {
          content: [{ type: "text", text }],
          details: { stacks }
        };
      }
    }),
    access.defineButlerTool({
      name: "start_stack",
      label: "Start stack",
      description: "Create one isolated stack lease and network for a multi-container job.",
      promptSnippet:
        "start_stack: use this before launching multiple cooperating previews or services for one job. Prefer storageMode=job for recurring mutable databases so each job gets its own writable fork from the project base. Use storageMode=base only when intentionally seeding or refreshing the shared base state.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        title: Type.String({ minLength: 1 }),
        cwd: Type.Optional(Type.String()),
        storageMode: Type.Optional(
          Type.Union([Type.Literal("ephemeral"), Type.Literal("job"), Type.Literal("base"), Type.Literal("custom")])
        ),
        retainsVolumes: Type.Optional(Type.Boolean()),
        storageKey: Type.Optional(Type.String()),
        cloneFromStorageKey: Type.Optional(Type.String()),
        sticky: Type.Optional(
          Type.Boolean({
            description: "Keep this stack lease across automatic cleanup so later jobs can reuse it."
          })
        ),
        leaseTtlMinutes: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Override the cleanup TTL for this stack lease when sticky is false."
          })
        )
      }),
      uiEffects: access.getToolUiEffects("start_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          threadId?: string;
          title: string;
          cwd?: string;
          storageMode?: "ephemeral" | "job" | "base" | "custom";
          retainsVolumes?: boolean;
          storageKey?: string;
          cloneFromStorageKey?: string;
          sticky?: boolean;
          leaseTtlMinutes?: number;
        };
        const thread = typedParams.threadId ? access.store.getThread(typedParams.threadId) ?? null : null;
        const worktreePath = typedParams.cwd?.trim() || thread?.cwd || null;
        const project = access.resolveWorkspaceProject(
          worktreePath,
          thread?.supervisor.projectId ?? "stack",
          thread?.supervisor.projectLabel ?? "stack"
        );
        const stack = withRequestedLeaseLifecycle(await access.runtimeBroker.createStack({
          stackId: crypto.randomUUID(),
          threadId: typedParams.threadId ?? null,
          projectId: project.id,
          projectLabel: project.label,
          title: typedParams.title.trim(),
          worktreePath,
          storageMode: normalizeStackStorageMode(typedParams.storageMode) ?? null,
          retainsVolumes: Boolean(typedParams.retainsVolumes),
          storageKey: typedParams.storageKey?.trim() || null,
          cloneFromStorageKey: typedParams.cloneFromStorageKey?.trim() || null
        }), typedParams);
        access.store.upsertStackLease(stack);
        return {
          content: [
            {
              type: "text",
              text: `Started stack ${stack.title}. Network=${stack.networkName}. ${access.describeStackStorage(stack)}. ${formatLeaseLifecycle(stack)}.`
            }
          ],
          details: { stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "inspect_stack",
      label: "Inspect stack",
      description: "Inspect one stack lease and return its current state.",
      promptSnippet: "inspect_stack: use this to confirm what a multi-container environment already contains before changing it.",
      parameters: Type.Object({
        stackId: Type.String()
      }),
      uiEffects: access.getToolUiEffects("inspect_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string };
        const inspected = await access.runtimeBroker.inspectStack(typedParams.stackId);
        access.store.upsertStackLease(inspected);
        const stack = access.store.noteStackLeaseActivity(inspected.id) ?? access.store.getStackLease(inspected.id) ?? inspected;
        return {
          content: [
            {
              type: "text",
              text: `${stack.title} is ${stack.status}. Network=${stack.networkName}. ${access.describeStackStorage(stack)}. ${formatLeaseLifecycle(stack)}. Previews=${stack.previewIds.length}. Services=${stack.serviceIds.length}.`
            }
          ],
          details: { stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "set_stack_lease",
      label: "Set stack lease",
      description: "Update a stack lease lifecycle, including sticky reuse and cleanup TTL.",
      promptSnippet:
        "set_stack_lease: use sticky=true when a stack should remain available for later jobs; use sticky=false or leaseTtlMinutes to return it to normal cleanup.",
      parameters: Type.Object({
        stackId: Type.String(),
        sticky: Type.Optional(Type.Boolean()),
        leaseTtlMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        refresh: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("set_stack_lease"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string; sticky?: boolean; leaseTtlMinutes?: number; refresh?: boolean };
        const current = access.getValidatedStack(typedParams.stackId?.trim() || null, null);
        if (!current) {
          throw new Error("Stack selector is required");
        }
        const stack = access.store.setStackLeaseLifecycle(current.id, {
          pinned: resolveStickyFlag(typedParams),
          leaseTtlMs: typedParams.leaseTtlMinutes === undefined ? undefined : normalizeLeaseTtlMs(typedParams.leaseTtlMinutes),
          refresh: typedParams.refresh !== false
        });
        if (!stack) {
          throw new Error(`Unknown stack: ${typedParams.stackId}`);
        }
        return {
          content: [{ type: "text", text: `Updated stack ${stack.title}. ${formatLeaseLifecycle(stack)}.` }],
          details: { stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "promote_stack",
      label: "Promote stack",
      description: "Copy a stack's retained volumes into another storage namespace.",
      promptSnippet: "promote_stack: use this when one job's retained database or object-store state should become the new shared base.",
      parameters: Type.Object({
        stackId: Type.String(),
        targetStorageKey: Type.Optional(Type.String())
      }),
      uiEffects: access.getToolUiEffects("promote_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string; targetStorageKey?: string };
        const promotion = await access.runtimeBroker.promoteStack({
          stackId: typedParams.stackId,
          targetStorageKey: typedParams.targetStorageKey?.trim() || null
        });
        const stack = await access.runtimeBroker.inspectStack(typedParams.stackId);
        access.store.upsertStackLease(stack);
        access.store.noteStackLeaseActivity(typedParams.stackId);
        return {
          content: [
            {
              type: "text",
              text: `Promoted ${promotion.promotedVolumes.length} volumes from ${promotion.sourceStorageKey} to ${promotion.targetStorageKey}.`
            }
          ],
          details: { promotion, stack }
        };
      }
    }),
    access.defineButlerTool({
      name: "stop_stack",
      label: "Stop stack",
      description: "Stop one stack lease, remove its members, and release its network.",
      promptSnippet: "stop_stack: use this to tear down a whole multi-container environment once the job is done.",
      parameters: Type.Object({
        stackId: Type.String(),
        dropVolumes: Type.Optional(Type.Boolean())
      }),
      uiEffects: access.getToolUiEffects("stop_stack"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as { stackId: string; dropVolumes?: boolean };
        const dropVolumes = typedParams.dropVolumes !== false;
        await access.runtimeBroker.stopStack(typedParams.stackId, { dropVolumes });
        access.removeStackArtifacts(typedParams.stackId);
        return {
          content: [
            {
              type: "text",
              text: `Stopped stack ${typedParams.stackId}.${dropVolumes ? " Dropped retained volumes." : ""}`
            }
          ],
          details: { stackId: typedParams.stackId, dropVolumes }
        };
      }
    })
  ];
}
