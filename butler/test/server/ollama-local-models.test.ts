import assert from "node:assert/strict";
import test from "node:test";

import { assertOllamaLocalBaseUrl, fetchOllamaLocalModels, nativeOllamaBaseUrl, normalizeOllamaModelName } from "../../src/server/ollama-local-models.js";

test("nativeOllamaBaseUrl strips OpenAI-compatible suffix", () => {
  assert.equal(nativeOllamaBaseUrl("http://ollama:11434/v1/"), "http://ollama:11434");
});

test("assertOllamaLocalBaseUrl rejects public hosts", () => {
  assert.equal(assertOllamaLocalBaseUrl("http://host.docker.internal:11434/"), "http://host.docker.internal:11434");
  assert.equal(assertOllamaLocalBaseUrl("http://192.168.1.12:11434"), "http://192.168.1.12:11434");
  assert.throws(() => assertOllamaLocalBaseUrl("https://api.example.com/v1"), /private network/);
});

test("normalizeOllamaModelName accepts Ollama and Hugging Face style model names", () => {
  assert.equal(normalizeOllamaModelName(" qwen3:8b "), "qwen3:8b");
  assert.equal(normalizeOllamaModelName("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"), "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M");
  assert.throws(() => normalizeOllamaModelName("qwen3 8b"), /cannot contain/);
  assert.throws(() => normalizeOllamaModelName(""), /required/);
});

test("fetchOllamaLocalModels filters embedding-only models", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/tags")) {
      return Response.json({
        models: [
          { name: "qwen3:8b" },
          { name: "qwen3-embedding:0.6b" }
        ]
      });
    }
    if (url.endsWith("/api/show")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (parsed.model === "qwen3-embedding:0.6b") {
        return Response.json({ capabilities: ["tools", "thinking", "embedding"], model_info: { "qwen.context_length": 8_192 } });
      }
      return Response.json({ capabilities: ["completion", "tools"], model_info: { "qwen.context_length": 32_768 } });
    }
    return new Response("not found", { status: 404 });
  };

  const models = await fetchOllamaLocalModels({ nativeBaseUrl: "http://ollama:11434/v1", timeoutMs: 1_000 }, fetchImpl);
  assert.deepEqual(models.map((model) => model.id), ["qwen3:8b"]);
  assert.equal(models[0]?.contextWindow, 32_768);
  assert.equal(calls.filter((url) => url.endsWith("/api/show")).length, 2);
});

test("fetchOllamaLocalModels skips models when metadata lookup fails", async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: [{ name: "unknown:latest" }] });
    }
    if (url.endsWith("/api/show")) {
      return new Response("missing", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };

  const models = await fetchOllamaLocalModels({ nativeBaseUrl: "http://ollama:11434", timeoutMs: 1_000 }, fetchImpl);
  assert.deepEqual(models, []);
});
