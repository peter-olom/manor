import path from "node:path";
import { readFile } from "node:fs/promises";

type HarnessCapability = {
  threadId: string;
  token: string;
};

export type ManorHarnessResult = {
  ok?: boolean;
  text?: string;
  error?: string;
  [key: string]: unknown;
};

function registryPath(env: NodeJS.ProcessEnv): string {
  if (env.MANOR_HARNESS_REGISTRY_PATH?.trim()) return env.MANOR_HARNESS_REGISTRY_PATH;
  const harnessHome = env.MANOR_HARNESS_HOME?.trim();
  if (!harnessHome) throw new Error("MANOR_HARNESS_REGISTRY_PATH or MANOR_HARNESS_HOME is required");
  return path.join(harnessHome, "harness-capabilities.json");
}

async function readThreadCapability(env: NodeJS.ProcessEnv): Promise<HarnessCapability> {
  const threadId = env.MANOR_THREAD_ID?.trim();
  if (!threadId) throw new Error("Manor Worker tools require MANOR_THREAD_ID.");
  const raw = await readFile(registryPath(env), "utf8").catch(() => "");
  if (!raw) throw new Error(`No Manor harness capability is available for job ${threadId}.`);
  const parsed = JSON.parse(raw) as { capabilities?: unknown[] };
  const capability = (Array.isArray(parsed.capabilities) ? parsed.capabilities : []).find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return record.threadId === threadId && typeof record.token === "string" && record.token.trim().length > 0;
  }) as HarnessCapability | undefined;
  if (!capability) throw new Error(`No Manor harness capability is available for job ${threadId}.`);
  return capability;
}

export async function callManorHarness(
  action: string,
  params: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ManorHarnessResult> {
  const capability = await readThreadCapability(env);
  const baseUrl = env.MANOR_BUTLER_BASE_URL || "http://butler:8080";
  const paths = ["/api/harness/action"];
  for (const [index, actionPath] of paths.entries()) {
    signal?.throwIfAborted();
    const response = await fetchImpl(new URL(actionPath, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: capability.token, action, params }),
      signal
    });
    const payload = await response.json().catch(() => ({ error: "Harness request failed" })) as ManorHarnessResult;
    if (response.status === 404 && index < paths.length - 1) continue;
    if (!response.ok || payload.ok === false) {
      throw new Error(typeof payload.error === "string" ? payload.error : `Harness request failed with ${response.status}`);
    }
    return payload;
  }
  throw new Error("Harness action endpoint is unavailable.");
}

export function formatManorHarnessResult(result: ManorHarnessResult): string {
  if (typeof result.text === "string" && result.text.trim()) return result.text;
  return JSON.stringify(result, null, 2);
}
