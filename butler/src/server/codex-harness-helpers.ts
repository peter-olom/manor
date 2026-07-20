import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type HarnessCapability = {
  id: string;
  token: string;
  threadId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
};

export type HarnessRegistryPayload = {
  capabilities: HarnessCapability[];
};

export type BrokerAccessRegistryPayload = {
  grants: Array<{
    token: string;
    threadId: string;
    createdAt: number;
    updatedAt: number;
  }>;
};

export function resolveHarnessStoragePaths(options: {
  stateDir: string;
  harnessRegistryPath?: string | null;
  harnessAccessPath?: string | null;
}) {
  const registryPath = normalizeString(options.harnessRegistryPath)
    || normalizeString(process.env.MANOR_HARNESS_REGISTRY_PATH)
    || path.join(options.stateDir, "harness-capabilities.json");
  return {
    registryPath,
    brokerAccessPath: normalizeString(options.harnessAccessPath)
      || normalizeString(process.env.MANOR_HARNESS_ACCESS_FILE)
      || path.join(options.stateDir, "harness-broker-access.json")
  };
}

export async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readHarnessRegistry(filePath: string): Promise<HarnessRegistryPayload | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as Partial<HarnessRegistryPayload>).capabilities)) {
      throw new Error("Harness capability registry must contain a capabilities array.");
    }
    return parsed as HarnessRegistryPayload;
  } catch (error) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(filePath, quarantinePath).catch(async () => {
      await fs.rm(filePath, { force: true });
    });
    console.warn(`Replaced malformed harness capability registry: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function writeHarnessRegistries(registryPath: string, brokerAccessPath: string, capabilities: Iterable<HarnessCapability>): Promise<void> {
  const payload: HarnessRegistryPayload = { capabilities: [...capabilities].sort((left, right) => left.createdAt - right.createdAt) };
  const brokerAccessPayload: BrokerAccessRegistryPayload = { grants: payload.capabilities.map((capability) => ({ token: capability.token, threadId: capability.threadId, createdAt: capability.createdAt, updatedAt: capability.updatedAt })) };
  await Promise.all([atomicWriteJson(registryPath, payload), atomicWriteJson(brokerAccessPath, brokerAccessPayload)]);
}

export function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((entry) => normalizeString(entry)).filter(Boolean))];
}

export function normalizeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
      .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0)
  );
}

export function normalizePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.trunc(numeric));
}

export function normalizeHeartbeatKind(value: unknown): "none" | "http" | "tcp" | "command" | null {
  const normalized = normalizeString(value);
  if (normalized === "none" || normalized === "http" || normalized === "tcp" || normalized === "command") {
    return normalized;
  }
  return null;
}

export function looksLikeHarnessLookupFailure(text: string): boolean {
  return /no manor harness capability|open this job through butler first|harness unavailable|no capability is available/i.test(text);
}

export function looksLikeSharedShellBootstrapFailure(text: string): boolean {
  return /corepack|node_modules|package-manager|package manager|dependency install|bootstrap|npm|pnpm|yarn|playwright|browser install|eai_again|403/i.test(
    text
  );
}

export function looksLikePreviewAttempt(text: string): boolean {
  return /manor-harness preview|preview start|preview use|browser use|preview inspect|pulling_image|pulling image|heartbeat|operator url|bootstrap phase|service start|stack start|preview execution/i.test(
    text
  );
}

export function looksLikeSharedShellEgressDiagnosis(text: string): boolean {
  return /manor-egress|err_access_denied|squid 403|direct host checks?|job host cannot reach|outbound https is being denied|curl(?:\s+-\S+)*\s+https?:\/\//i.test(
    text
  );
}
