import { EventEmitter } from "node:events";

import type { CodexAppServerTransport, JsonRpcMessage } from "./codex-app-server-transport.js";
import { mapCodexProviderEvent } from "./codex-provider-events.js";
import type {
  ProviderRuntimeAdapter,
  ProviderRuntimeEvent,
  ProviderRuntimeThreadResult,
  ProviderRuntimeThreadSnapshot,
  ProviderRuntimeTurnResult
} from "../shared/provider-runtime.js";

type CodexProviderAdapterEvents = {
  runtimeEvent: [ProviderRuntimeEvent];
  unmappedNotification: [JsonRpcMessage];
};

type CodexListResult = {
  data: Record<string, unknown>[];
  nextCursor: string | null;
};

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function listResult(result: Record<string, unknown>): CodexListResult {
  return {
    data: recordArray(result.data),
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
}

function threadResult(result: Record<string, unknown>): ProviderRuntimeThreadResult {
  const thread = recordOrNull(result.thread);
  const threadId = typeof thread?.id === "string" ? thread.id : null;
  if (!threadId) {
    throw new Error("Provider did not return a thread id");
  }
  return { threadId, thread };
}

function turnResult(threadId: string, result: Record<string, unknown>): ProviderRuntimeTurnResult {
  const turn = recordOrNull(result.turn);
  return {
    threadId,
    turnId: typeof turn?.id === "string" ? turn.id : undefined,
    turn: turn ?? undefined
  };
}

export class CodexProviderAdapter extends EventEmitter<CodexProviderAdapterEvents> implements ProviderRuntimeAdapter {
  readonly harness = "codex";

  constructor(private readonly transport: CodexAppServerTransport) {
    super();
  }

  handleNotification(message: JsonRpcMessage): void {
    if (!message.method) {
      return;
    }

    const events = mapCodexProviderEvent({
      method: message.method,
      params: message.params ?? {}
    });
    if (events.length === 0) {
      this.emit("unmappedNotification", message);
      return;
    }

    for (const event of events) {
      this.emit("runtimeEvent", event);
    }
  }

  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.transport.call(method, params);
  }

  onRuntimeEvent(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.on("runtimeEvent", listener);
    return () => this.off("runtimeEvent", listener);
  }

  async listThreads(input: Record<string, unknown>): Promise<CodexListResult> {
    return listResult(await this.call("thread/list", input));
  }

  async listLoadedThreads(): Promise<string[]> {
    const result = await this.call("thread/loaded/list", {});
    return stringArray(result.data);
  }

  async listModels(input: Record<string, unknown>): Promise<CodexListResult> {
    return listResult(await this.call("model/list", input));
  }

  async readDirectory(directoryPath: string): Promise<Record<string, unknown> | null> {
    return this.call("fs/readDirectory", { path: directoryPath }).catch(() => null);
  }

  async listSkills(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.call("skills/list", input);
    return recordArray(result.data);
  }

  async listApps(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.call("app/list", input);
    return recordArray(result.data);
  }

  async listPluginMarketplaces(input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const result = await this.call("plugin/list", input);
    return recordArray(result.marketplaces);
  }

  async listCollaborationModes(): Promise<Record<string, unknown>[]> {
    const result = await this.call("collaborationMode/list", {}).catch(() => null);
    return recordArray(result?.data);
  }

  async loadThread(threadId: string, input: Record<string, unknown> = {}): Promise<ProviderRuntimeThreadSnapshot> {
    const result = await this.call("thread/read", { threadId, includeTurns: true, ...input });
    const thread = recordOrNull(result.thread);
    return {
      threadId,
      thread: thread ?? undefined,
      turns: recordArray(thread?.turns).map((turn) => ({
        id: typeof turn.id === "string" ? turn.id : "",
        items: Array.isArray(turn.items) ? turn.items : []
      })).filter((turn) => turn.id)
    };
  }

  async resumeThread(threadId: string, input: Record<string, unknown> = {}): Promise<ProviderRuntimeThreadResult> {
    const result = await this.call("thread/resume", { threadId, ...input });
    const thread = recordOrNull(result.thread);
    return { threadId: typeof thread?.id === "string" ? thread.id : threadId, thread: thread ?? undefined };
  }

  async startThread(input: Record<string, unknown>): Promise<ProviderRuntimeThreadResult> {
    return threadResult(await this.call("thread/start", input));
  }

  async sendTurn(threadId: string, input: Record<string, unknown>): Promise<ProviderRuntimeTurnResult> {
    return turnResult(threadId, await this.call("turn/start", { threadId, ...input }));
  }

  async steerTurn(threadId: string, turnId: string, input: unknown): Promise<void> {
    await this.call("turn/steer", {
      threadId,
      turnId,
      input
    });
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    await this.call("turn/interrupt", {
      threadId,
      ...(turnId ? { turnId } : {})
    });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.call("thread/unsubscribe", { threadId });
  }
}
