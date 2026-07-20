import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";

export type ButlerExecutorResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
};

export type ButlerExecutorClientOptions = {
  socketPath?: string;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
  harnessRegistryPath?: string;
  contentAdmissionPolicyPath?: string;
};

type ExecutorFrame = ButlerExecutorResult & { type: "result"; id: string };

export class ButlerExecutorClient {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly harnessRegistryPath: string;
  private readonly contentAdmissionPolicyPath: string;

  constructor(options: ButlerExecutorClientOptions = {}) {
    this.socketPath = options.socketPath ?? "/butler-executor-runtime/executor.sock";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 512 * 1024;
    this.harnessRegistryPath = options.harnessRegistryPath ?? "/harness-state/harness-capabilities.json";
    this.contentAdmissionPolicyPath = options.contentAdmissionPolicyPath ?? "/harness-state/content-admission-policy.json";
  }

  async execute(input: { script: string; threadId: string; timezone?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ButlerExecutorResult> {
    const [parsed, policy] = await Promise.all([
      readFile(this.harnessRegistryPath, "utf8").then((value) => JSON.parse(value) as { capabilities?: Array<Record<string, unknown>> }),
      readFile(this.contentAdmissionPolicyPath, "utf8").then((value) => JSON.parse(value) as { mode?: unknown })
    ]);
    const carCapability = parsed.capabilities?.find((entry) => entry.threadId === input.threadId && typeof entry.token === "string");
    if (!carCapability) throw new Error(`Butler executor CAR capability is unavailable for ${input.threadId}.`);
    if (!policy || !["review", "enforce", "off"].includes(String(policy.mode))) throw new Error("Butler executor CAR policy is unavailable.");
    return this.executeWithCapability(input, carCapability, { mode: String(policy.mode) });
  }

  private executeWithCapability(
    input: { script: string; threadId: string; timezone?: string; timeoutMs?: number; signal?: AbortSignal },
    carCapability: Record<string, unknown>,
    carPolicy: { mode: string }
  ): Promise<ButlerExecutorResult> {
    const id = crypto.randomUUID();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("Butler executor request was aborted."));
        return;
      }

      const socket = net.createConnection({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(new Error("Butler executor did not respond before its deadline.")), timeoutMs + 2_000);
      timer.unref();

      const finish = (error?: Error, result?: ButlerExecutorResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as ButlerExecutorResult);
      };
      const abort = () => finish(input.signal?.reason instanceof Error ? input.signal.reason : new Error("Butler executor request was aborted."));
      input.signal?.addEventListener("abort", abort, { once: true });

      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ type: "exec", id, threadId: input.threadId, carCapability, carPolicy, script: input.script, timeoutMs, timezone: input.timezone })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > this.maxResponseBytes) {
          finish(new Error("Butler executor response exceeded the size limit."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const frame = JSON.parse(buffer.slice(0, newline)) as Partial<Omit<ExecutorFrame, "type">> & { type?: unknown; message?: unknown };
          if (frame.type === "error") throw new Error(typeof frame.message === "string" ? frame.message : "Butler executor failed.");
          if (frame.type !== "result" || frame.id !== id) throw new Error("Butler executor returned an invalid response.");
          if (typeof frame.stdout !== "string" || typeof frame.stderr !== "string" || !Number.isInteger(frame.exitCode)) {
            throw new Error("Butler executor returned an incomplete result.");
          }
          finish(undefined, {
            stdout: frame.stdout,
            stderr: frame.stderr,
            exitCode: frame.exitCode as number,
            signal: typeof frame.signal === "string" ? frame.signal : null,
            timedOut: frame.timedOut === true,
            truncated: frame.truncated === true
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("error", (error) => finish(new Error(`Butler executor is unavailable: ${error.message}`)));
      socket.once("end", () => {
        if (!settled) finish(new Error("Butler executor closed without a result."));
      });
    });
  }
}
