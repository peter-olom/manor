import { promises as fs } from "node:fs";

import { listThreadSessionFiles } from "./codex-session-artifacts.js";
import type { CodexItemRecord } from "./types.js";

type TranscriptActivityItem = CodexItemRecord & {
  callId?: string | null;
};

export type CodexTranscriptTurnActivity = {
  turnId: string;
  items: CodexItemRecord[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function timestampMs(record: Record<string, unknown>): number {
  const timestamp = asString(record.timestamp);
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function turnIdFromPayload(payload: Record<string, unknown>, callsById: Map<string, TranscriptActivityItem>): string | null {
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  const fromMetadata = asString(metadata?.turn_id);
  if (fromMetadata) {
    return fromMetadata;
  }

  const callId = asString(payload.call_id);
  const prior = callId ? callsById.get(callId) : null;
  return typeof prior?.raw.turnId === "string" ? prior.raw.turnId : null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function compactText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function limitText(value: string, limit = 24_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit).trimEnd()}\n\n[truncated]`;
}

function optionalSection(label: string, value: string | null): string | null {
  const clean = value?.trim();
  return clean ? `${label}\n${clean}` : null;
}

function commandText(name: string, args: Record<string, unknown> | null): string {
  if (name === "exec_command") {
    const command = compactText(args?.cmd);
    const workdir = compactText(args?.workdir);
    return [
      command,
      workdir ? `Working directory\n${workdir}` : null
    ].filter((entry): entry is string => Boolean(entry && entry.trim())).join("\n\n");
  }

  return [
    name,
    optionalSection("Arguments", args ? JSON.stringify(args, null, 2) : null)
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
}

function customToolText(name: string, input: unknown): string {
  return [
    name,
    optionalSection(name === "apply_patch" ? "Patch" : "Input", compactText(input))
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
}

function searchText(payload: Record<string, unknown>): string {
  const args = asRecord(payload.arguments);
  return [
    compactText(args?.query) || compactText(payload.query),
    optionalSection("Arguments", args ? JSON.stringify(args, null, 2) : null)
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
}

function toolSearchOutput(payload: Record<string, unknown>): string {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length === 0) {
    return compactText(payload.output);
  }

  const names = tools
    .map((entry) => asRecord(entry)?.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return names.length > 0 ? names.join("\n") : JSON.stringify(tools, null, 2);
}

function readableMessageContent(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return asString(record?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readableReasoning(payload: Record<string, unknown>): string {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  return summary
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const record = asRecord(entry);
      return asString(record?.text) ?? asString(record?.summary) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function responseItemType(payload: Record<string, unknown>): string {
  const type = asString(payload.type) ?? "unknown";
  const name = asString(payload.name) ?? "";
  if (type === "function_call" && name === "exec_command") {
    return "commandExecution";
  }
  if (type === "custom_tool_call" && name === "apply_patch") {
    return "fileChange";
  }
  if (type === "tool_search_call" || type === "tool_search_output") {
    return "webSearch";
  }
  if (type === "reasoning") {
    return "reasoning";
  }
  return type.endsWith("_call") ? type : "dynamic_tool_call";
}

function makeItem(input: {
  id: string;
  type: string;
  text: string;
  at: number;
  status?: "started" | "completed";
  raw?: Record<string, unknown>;
  callId?: string | null;
  turnId: string;
}): TranscriptActivityItem {
  return {
    id: input.id,
    type: input.type,
    status: input.status ?? "completed",
    text: input.text,
    at: input.at,
    raw: { ...(input.raw ?? {}), turnId: input.turnId },
    callId: input.callId ?? null
  };
}

function appendResponse(item: TranscriptActivityItem, response: string, at: number): void {
  const clean = limitText(response);
  if (!clean) {
    return;
  }
  item.text = `${item.text.trim()}\n\nResponse\n${clean}`;
  item.status = "completed";
  item.at = Math.max(item.at, at);
}

export function recoverCodexTranscriptActivityFromText(raw: string): CodexTranscriptTurnActivity[] {
  const itemsByTurn = new Map<string, TranscriptActivityItem[]>();
  const callsById = new Map<string, TranscriptActivityItem>();

  function push(turnId: string, item: TranscriptActivityItem): void {
    const existing = itemsByTurn.get(turnId) ?? [];
    const index = existing.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      existing[index] = item;
    } else {
      existing.push(item);
    }
    itemsByTurn.set(turnId, existing);
    if (item.callId) {
      callsById.set(item.callId, item);
    }
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    const payload = asRecord(record.payload);
    if (!payload) {
      continue;
    }

    const payloadType = asString(payload.type);
    const at = timestampMs(record);
    const turnId = turnIdFromPayload(payload, callsById);
    if (!turnId) {
      continue;
    }

    if (payloadType === "message") {
      continue;
    }

    if (payloadType === "reasoning") {
      const text = readableReasoning(payload);
      if (!text) {
        continue;
      }
      push(turnId, makeItem({
        id: asString(payload.id) ?? `reasoning:${turnId}:${at}`,
        type: "reasoning",
        text,
        at,
        raw: payload,
        turnId
      }));
      continue;
    }

    if (payloadType === "function_call") {
      const name = asString(payload.name) ?? "tool";
      const args = parseJsonRecord(asString(payload.arguments));
      const callId = asString(payload.call_id);
      push(turnId, makeItem({
        id: asString(payload.id) ?? `call:${callId ?? at}`,
        type: responseItemType(payload),
        text: commandText(name, args),
        at,
        status: asString(payload.status) === "completed" ? "completed" : "started",
        raw: payload,
        callId,
        turnId
      }));
      continue;
    }

    if (payloadType === "custom_tool_call") {
      const name = asString(payload.name) ?? "tool";
      const callId = asString(payload.call_id);
      push(turnId, makeItem({
        id: asString(payload.id) ?? `call:${callId ?? at}`,
        type: responseItemType(payload),
        text: customToolText(name, payload.input),
        at,
        status: asString(payload.status) === "completed" ? "completed" : "started",
        raw: payload,
        callId,
        turnId
      }));
      continue;
    }

    if (payloadType === "tool_search_call") {
      const callId = asString(payload.call_id);
      push(turnId, makeItem({
        id: asString(payload.id) ?? `call:${callId ?? at}`,
        type: "webSearch",
        text: searchText(payload),
        at,
        status: asString(payload.status) === "completed" ? "completed" : "started",
        raw: payload,
        callId,
        turnId
      }));
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output" || payloadType === "tool_search_output") {
      const callId = asString(payload.call_id);
      const item = callId ? callsById.get(callId) : null;
      if (!item) {
        continue;
      }
      appendResponse(
        item,
        payloadType === "tool_search_output" ? toolSearchOutput(payload) : (asString(payload.output) ?? readableMessageContent(payload)),
        at
      );
    }
  }

  return [...itemsByTurn.entries()]
    .map(([turnId, items]) => ({
      turnId,
      items: items
        .filter((item) => item.text.trim().length > 0)
        .map(({ callId: _callId, ...item }) => item)
        .sort((left, right) => left.at - right.at)
    }))
    .filter((turn) => turn.items.length > 0);
}

export async function recoverCodexTranscriptActivity(
  codexHomeDir: string,
  threadId: string,
  threadCreatedAt: number | null
): Promise<CodexTranscriptTurnActivity[]> {
  const files = await listThreadSessionFiles(codexHomeDir, threadId, threadCreatedAt);
  if (files.length === 0) {
    return [];
  }

  const merged = new Map<string, CodexItemRecord[]>();
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    for (const turn of recoverCodexTranscriptActivityFromText(raw)) {
      const existing = merged.get(turn.turnId) ?? [];
      const byId = new Map(existing.map((item) => [item.id, item]));
      for (const item of turn.items) {
        byId.set(item.id, item);
      }
      merged.set(turn.turnId, [...byId.values()].sort((left, right) => left.at - right.at));
    }
  }

  return [...merged.entries()].map(([turnId, items]) => ({ turnId, items }));
}
