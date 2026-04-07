import { promises as fs } from "node:fs";

import type { ServiceConnectionView, ServiceLeaseView, ServiceTemplateView } from "./types.js";

type ServiceTemplateConfig = {
  templates?: ServiceTemplateConfigEntry[];
};

type ServiceTemplateConfigEntry = {
  id?: string;
  label?: string;
  description?: string;
  runtimeKind?: "container" | "embedded";
  engine?: string;
  image?: string;
  port?: number;
  notes?: string | null;
  command?: string;
  envDefaults?: Record<string, string>;
  fileName?: string;
  stackVolumePath?: string;
  connection?: {
    databaseEnv?: string;
    databaseValue?: string;
    usernameEnv?: string;
    usernameValue?: string;
    passwordEnv?: string;
    passwordValue?: string;
    uriTemplate?: string;
    notes?: string | null;
  };
};

export type LoadedServiceTemplate = ServiceTemplateView & {
  command: string | null;
  envDefaults: Record<string, string>;
  fileName: string | null;
  connection: {
    databaseEnv: string | null;
    databaseValue: string | null;
    usernameEnv: string | null;
    usernameValue: string | null;
    passwordEnv: string | null;
    passwordValue: string | null;
    uriTemplate: string | null;
    notes: string | null;
  };
};

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, entryValue]) => [key, entryValue.trim()])
      .filter((entry) => entry[0].trim() && entry[1])
  );
}

export async function loadServiceTemplates(configPath: string): Promise<LoadedServiceTemplate[]> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as ServiceTemplateConfig;
  const entries = Array.isArray(parsed.templates) ? parsed.templates : [];

  return entries.flatMap((entry) => {
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.label !== "string" ||
      typeof entry?.description !== "string" ||
      typeof entry?.runtimeKind !== "string" ||
      typeof entry?.engine !== "string" ||
      typeof entry?.image !== "string" ||
      typeof entry?.port !== "number"
    ) {
      return [];
    }

    return [
      {
        id: entry.id.trim(),
        label: entry.label.trim(),
        description: entry.description.trim(),
        runtimeKind: entry.runtimeKind,
        engine: entry.engine.trim(),
        image: entry.image.trim(),
        defaultPort: entry.port,
        stackVolumePath:
          typeof entry.stackVolumePath === "string" && entry.stackVolumePath.trim() ? entry.stackVolumePath.trim() : null,
        notes: typeof entry.notes === "string" ? entry.notes.trim() : null,
        command: typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : null,
        envDefaults: normalizeRecord(entry.envDefaults),
        fileName: typeof entry.fileName === "string" && entry.fileName.trim() ? entry.fileName.trim() : null,
        connection: {
          databaseEnv: typeof entry.connection?.databaseEnv === "string" ? entry.connection.databaseEnv.trim() : null,
          databaseValue: typeof entry.connection?.databaseValue === "string" ? entry.connection.databaseValue.trim() : null,
          usernameEnv: typeof entry.connection?.usernameEnv === "string" ? entry.connection.usernameEnv.trim() : null,
          usernameValue: typeof entry.connection?.usernameValue === "string" ? entry.connection.usernameValue.trim() : null,
          passwordEnv: typeof entry.connection?.passwordEnv === "string" ? entry.connection.passwordEnv.trim() : null,
          passwordValue: typeof entry.connection?.passwordValue === "string" ? entry.connection.passwordValue.trim() : null,
          uriTemplate: typeof entry.connection?.uriTemplate === "string" ? entry.connection.uriTemplate.trim() : null,
          notes: typeof entry.connection?.notes === "string" ? entry.connection.notes.trim() : null
        }
      }
    ];
  });
}

function resolveConnectionValue(
  env: Record<string, string>,
  envKey: string | null,
  staticValue: string | null
): string | null {
  if (staticValue) {
    return staticValue;
  }

  if (envKey) {
    const value = env[envKey];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  return null;
}

function interpolateTemplate(template: string, values: Record<string, string | number | null>): string {
  return template.replace(/\{([A-Z0-9_]+)\}/g, (_match, key) => {
    const value = values[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function buildServiceConnection(
  template: LoadedServiceTemplate,
  host: string,
  port: number,
  env: Record<string, string>,
  worktreePath?: string | null
): ServiceConnectionView {
  const database = resolveConnectionValue(env, template.connection.databaseEnv, template.connection.databaseValue);
  const username = resolveConnectionValue(env, template.connection.usernameEnv, template.connection.usernameValue);
  const password = resolveConnectionValue(env, template.connection.passwordEnv, template.connection.passwordValue);

  const uri =
    template.connection.uriTemplate
      ? interpolateTemplate(template.connection.uriTemplate, {
          HOST: host,
          PORT: port,
          DATABASE: database,
          USERNAME: username,
          PASSWORD: password,
          PATH: worktreePath ?? ""
        })
      : null;

  return {
    engine: template.engine,
    host,
    port,
    database,
    username,
    password,
    uri,
    notes: template.connection.notes ?? template.notes
  };
}

export function toServiceLeaseView(input: {
  id: string;
  threadId: string | null;
  projectId: string;
  projectLabel: string;
  title: string;
  stackId?: string | null;
  aliases?: string[];
  template: LoadedServiceTemplate;
  containerName: string;
  targetHost: string;
  targetPort: number;
  worktreePath?: string | null;
  status: ServiceLeaseView["status"];
  storageKind?: ServiceLeaseView["storageKind"];
  sticky?: boolean;
  volumeName?: string | null;
  volumeMountPath?: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  env: Record<string, string>;
}): ServiceLeaseView {
  return {
    id: input.id,
    threadId: input.threadId,
    projectId: input.projectId,
    projectLabel: input.projectLabel,
    title: input.title,
    stackId: input.stackId ?? null,
    aliases: input.aliases ?? [],
    templateId: input.template.id,
    templateLabel: input.template.label,
    runtimeKind: input.template.runtimeKind,
    containerName: input.containerName,
    targetHost: input.targetHost,
    targetPort: input.targetPort,
    worktreePath: input.worktreePath ?? null,
    image: input.template.image,
    status: input.status,
    storageKind: input.storageKind ?? (input.template.runtimeKind === "embedded" ? "worktree" : "ephemeral"),
    sticky: input.sticky ?? input.template.runtimeKind === "embedded",
    volumeName: input.volumeName ?? null,
    volumeMountPath: input.volumeMountPath ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastError: input.lastError,
    pinned: false,
    lastActivityAt: input.updatedAt,
    leaseTtlMs: null,
    expiresAt: null,
    expiredAt: null,
    reapAfterAt: null,
    lifecycleState: "active",
    connection: buildServiceConnection(input.template, input.targetHost, input.targetPort, input.env, input.worktreePath)
  };
}
