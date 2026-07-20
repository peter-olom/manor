import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import type { ContentAdmissionResult, ContentAdmissionSource } from "./content-admission-review.js";

type Capability = { threadId?: unknown; token?: unknown; cwd?: unknown };

export async function admitContentThroughButler(source: ContentAdmissionSource, content: string, metadata = ""): Promise<ContentAdmissionResult> {
  const registryPath = process.env.MANOR_HARNESS_REGISTRY_PATH;
  const threadId = process.env.MANOR_THREAD_ID;
  const baseUrl = process.env.MANOR_BUTLER_BASE_URL;
  const socketPath = process.env.MANOR_HARNESS_SOCKET_PATH;
  if (!registryPath || (!baseUrl && !socketPath)) throw new Error("Content admission is not connected to Butler.");
  const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as { capabilities?: Capability[] };
  const currentCwd = path.resolve(process.cwd());
  const capability = parsed.capabilities?.find((entry) => entry.threadId === threadId && typeof entry.token === "string")
    ?? parsed.capabilities?.filter((entry) => typeof entry.token === "string" && typeof entry.cwd === "string" && (currentCwd === path.resolve(entry.cwd) || currentCwd.startsWith(`${path.resolve(entry.cwd)}${path.sep}`))).sort((left, right) => String(right.cwd).length - String(left.cwd).length)[0];
  if (!capability || typeof capability.token !== "string") throw new Error("Content admission capability is unavailable.");
  const body = JSON.stringify({ token: capability.token, action: "content.admit", params: { source, content, metadata } });
  const result = socketPath ? await requestAdmissionSocket(socketPath, body) : await requestAdmissionUrl(baseUrl!, body);
  const payload = result.payload;
  if (!result.ok || !payload?.ok || !payload.data?.admission) throw new Error(payload?.error || "Content admission request failed.");
  return payload.data.admission;
}

type AdmissionPayload = { ok?: boolean; error?: string; data?: { admission?: ContentAdmissionResult } } | null;

async function requestAdmissionUrl(baseUrl: string, body: string): Promise<{ ok: boolean; payload: AdmissionPayload }> {
  const response = await fetch(new URL("/api/harness/action", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body });
  return { ok: response.ok, payload: await response.json().catch(() => null) as AdmissionPayload };
}

async function requestAdmissionSocket(socketPath: string, body: string): Promise<{ ok: boolean; payload: AdmissionPayload }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/api/harness/action", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          resolve({ ok: (response.statusCode ?? 500) < 400, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as AdmissionPayload });
        } catch {
          resolve({ ok: false, payload: null });
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
