import crypto from "node:crypto";

import { getActiveManorSettings } from "./manor-settings-runtime.js";

export type MemoryEmbeddingConfig = {
  enabled: boolean;
  provider: "ollama";
  host: string;
  model: string;
  timeoutMs: number;
  backfillBatchSize: number;
};

export type MemoryEmbeddingProvider = {
  embed(texts: string[]): Promise<number[][]>;
};

export function readMemoryEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): MemoryEmbeddingConfig {
  const settings = getActiveManorSettings(env).embeddings;
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    host: settings.host,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    backfillBatchSize: settings.backfillBatchSize
  };
}

export function hashEmbeddingText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function encodeFloat32Vector(vector: number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(Number.isFinite(value) ? value : 0, index * 4));
  return buffer.toString("base64");
}

export function decodeFloat32Vector(base64: string, dimension: number): number[] {
  const buffer = Buffer.from(base64, "base64");
  const count = Math.min(Math.trunc(dimension), Math.floor(buffer.length / 4));
  const vector: number[] = [];
  for (let index = 0; index < count; index += 1) {
    vector.push(buffer.readFloatLE(index * 4));
  }
  return vector;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export class OllamaMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  constructor(private readonly config: MemoryEmbeddingConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.host}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Ollama embedding request failed with ${response.status}`);
      }
      const payload = await response.json() as { embeddings?: unknown };
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
      return embeddings.map((vector) => Array.isArray(vector) ? vector.map((value) => Number(value) || 0) : []);
    } finally {
      clearTimeout(timeout);
    }
  }
}
