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
  codexHomeDir?: string;
  harnessRegistryPath?: string | null;
  harnessAccessPath?: string | null;
}) {
  const legacyRegistryPath = options.codexHomeDir
    ? path.join(options.codexHomeDir, "manor", "harness-capabilities.json")
    : null;
  const registryPath = normalizeString(options.harnessRegistryPath)
    || normalizeString(process.env.MANOR_HARNESS_REGISTRY_PATH)
    || path.join(options.stateDir, "harness-capabilities.json");
  return {
    registryPath,
    legacyRegistryPath: legacyRegistryPath === registryPath ? null : legacyRegistryPath,
    brokerAccessPath: normalizeString(options.harnessAccessPath)
      || normalizeString(process.env.MANOR_HARNESS_ACCESS_FILE)
      || path.join(options.stateDir, "harness-broker-access.json"),
    legacyBrokerAccessPath: path.join(options.stateDir, "codex-broker-access.json")
  };
}

export async function readHarnessRegistryText(primaryPath: string, legacyPath: string | null) {
  const primary = await fs.readFile(primaryPath, "utf8").catch(() => "");
  if (primary || !legacyPath) return { raw: primary, fromLegacy: false };
  const legacy = await fs.readFile(legacyPath, "utf8").catch(() => "");
  return { raw: legacy, fromLegacy: Boolean(legacy) };
}

export async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
