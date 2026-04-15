import { promises as fs } from "node:fs";
import path from "node:path";

import type { ServiceConnectionView, ServiceLeaseView, ServiceTemplateView } from "./types.js";

export type ServiceTemplateInput = {
  id?: string;
  label?: string;
  description?: string;
  runtimeKind?: "container" | "embedded";
  engine?: string;
  image?: string;
  port?: number;
  notes?: string | null;
  command?: string;
  workingDir?: string;
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

const DEFAULT_TEMPLATE_INPUTS: ServiceTemplateInput[] = [
  {
    id: "postgres",
    label: "Postgres",
    description: "Disposable PostgreSQL database for app previews and local development workflows.",
    runtimeKind: "container",
    engine: "postgres",
    image: "postgres:16-bookworm",
    port: 5432,
    stackVolumePath: "/var/lib/postgresql/data",
    envDefaults: {
      POSTGRES_USER: "manor",
      POSTGRES_PASSWORD: "manor",
      POSTGRES_DB: "app"
    },
    connection: {
      databaseEnv: "POSTGRES_DB",
      usernameEnv: "POSTGRES_USER",
      passwordEnv: "POSTGRES_PASSWORD",
      uriTemplate: "postgresql://{USERNAME}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}"
    }
  },
  {
    id: "redis",
    label: "Redis",
    description: "Disposable Redis cache for queues, sessions, and local app state.",
    runtimeKind: "container",
    engine: "redis",
    image: "redis:7-bookworm",
    port: 6379,
    command: "redis-server --dir /data --appendonly yes",
    workingDir: "/data",
    stackVolumePath: "/data",
    connection: {
      uriTemplate: "redis://{HOST}:{PORT}/0"
    }
  },
  {
    id: "mysql",
    label: "MySQL",
    description: "Disposable MySQL database for local development and preview environments.",
    runtimeKind: "container",
    engine: "mysql",
    image: "mysql:8.4",
    port: 3306,
    stackVolumePath: "/var/lib/mysql",
    envDefaults: {
      MYSQL_DATABASE: "app",
      MYSQL_USER: "manor",
      MYSQL_PASSWORD: "manor",
      MYSQL_ROOT_PASSWORD: "manor-root"
    },
    connection: {
      databaseEnv: "MYSQL_DATABASE",
      usernameEnv: "MYSQL_USER",
      passwordEnv: "MYSQL_PASSWORD",
      uriTemplate: "mysql://{USERNAME}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}"
    }
  },
  {
    id: "rabbitmq",
    label: "RabbitMQ",
    description: "Disposable RabbitMQ broker for queues, async workers, and event-driven app flows.",
    runtimeKind: "container",
    engine: "rabbitmq",
    image: "rabbitmq:4-management",
    port: 5672,
    stackVolumePath: "/var/lib/rabbitmq",
    envDefaults: {
      RABBITMQ_DEFAULT_USER: "manor",
      RABBITMQ_DEFAULT_PASS: "manor",
      RABBITMQ_DEFAULT_VHOST: "app"
    },
    connection: {
      databaseEnv: "RABBITMQ_DEFAULT_VHOST",
      usernameEnv: "RABBITMQ_DEFAULT_USER",
      passwordEnv: "RABBITMQ_DEFAULT_PASS",
      uriTemplate: "amqp://{USERNAME}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}",
      notes: "RabbitMQ management stays inside the container on port 15672."
    }
  },
  {
    id: "mssql",
    label: "MSSQL",
    description: "Disposable SQL Server instance for local preview and integration testing.",
    runtimeKind: "container",
    engine: "mssql",
    image: "mcr.microsoft.com/mssql/server:2022-latest",
    port: 1433,
    stackVolumePath: "/var/opt/mssql",
    envDefaults: {
      ACCEPT_EULA: "Y",
      MSSQL_PID: "Developer",
      MSSQL_SA_PASSWORD: "ManorDevPassw0rd!"
    },
    connection: {
      databaseValue: "master",
      usernameValue: "sa",
      passwordEnv: "MSSQL_SA_PASSWORD",
      uriTemplate: "sqlserver://{USERNAME}:{PASSWORD}@{HOST}:{PORT};database={DATABASE};encrypt=true;trustServerCertificate=true"
    }
  },
  {
    id: "minio",
    label: "MinIO",
    description: "Disposable S3-compatible object store for uploads, fixtures, and local blob workflows.",
    runtimeKind: "container",
    engine: "s3",
    image: "minio/minio:latest",
    port: 9000,
    stackVolumePath: "/data",
    command: "minio server /data --console-address :9001",
    envDefaults: {
      MINIO_ROOT_USER: "manor",
      MINIO_ROOT_PASSWORD: "manor-dev-secret"
    },
    connection: {
      usernameEnv: "MINIO_ROOT_USER",
      passwordEnv: "MINIO_ROOT_PASSWORD",
      uriTemplate: "http://{HOST}:{PORT}",
      notes: "MinIO console stays inside the container on port 9001."
    }
  },
  {
    id: "mailpit",
    label: "Mailpit",
    description: "Disposable SMTP sink for local email testing and preview verification.",
    runtimeKind: "container",
    engine: "smtp",
    image: "axllent/mailpit:latest",
    port: 1025,
    connection: {
      uriTemplate: "smtp://{HOST}:{PORT}",
      notes: "Mailpit web UI stays inside the container on port 8025."
    }
  },
  {
    id: "sqlite",
    label: "SQLite",
    description: "Embedded SQLite database file created directly inside the worktree for lightweight local development.",
    runtimeKind: "embedded",
    engine: "sqlite",
    image: "builtin/sqlite",
    port: 0,
    fileName: ".manor/sqlite/app.db",
    connection: {
      databaseValue: ".manor/sqlite/app.db",
      uriTemplate: "file:{PATH}"
    },
    notes: "SQLite does not run as a container. Butler provisions the database file in the chosen worktree."
  }
];

export type LoadedServiceTemplate = ServiceTemplateView & {
  command: string | null;
  workingDir: string | null;
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
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
      .filter((entry) => entry[0].trim() && entry[1])
  );
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTemplateInput(input: ServiceTemplateInput): LoadedServiceTemplate | null {
  if (
    typeof input.id !== "string" ||
    typeof input.label !== "string" ||
    typeof input.description !== "string" ||
    typeof input.runtimeKind !== "string" ||
    typeof input.engine !== "string"
  ) {
    return null;
  }

  const id = input.id.trim().toLowerCase();
  const label = input.label.trim();
  const description = input.description.trim();
  const engine = input.engine.trim();
  if (input.runtimeKind !== "container" && input.runtimeKind !== "embedded") {
    return null;
  }

  const image =
    typeof input.image === "string" && input.image.trim()
      ? input.image.trim()
      : input.runtimeKind === "embedded"
        ? `builtin/${engine.toLowerCase()}`
        : "";
  const defaultPort =
    typeof input.port === "number" && Number.isFinite(input.port)
      ? Math.max(0, Math.trunc(input.port))
      : input.runtimeKind === "embedded"
        ? 0
        : NaN;
  if (!id || !label || !description || !engine || !image || !Number.isFinite(defaultPort)) {
    return null;
  }

  return {
    id,
    label,
    description,
    runtimeKind: input.runtimeKind,
    engine,
    image,
    defaultPort,
    stackVolumePath: normalizeNullableString(input.stackVolumePath),
    notes: normalizeNullableString(input.notes),
    command: normalizeNullableString(input.command),
    workingDir: normalizeNullableString(input.workingDir),
    envDefaults: normalizeRecord(input.envDefaults),
    fileName: normalizeNullableString(input.fileName),
    connection: {
      databaseEnv: normalizeNullableString(input.connection?.databaseEnv),
      databaseValue: normalizeNullableString(input.connection?.databaseValue),
      usernameEnv: normalizeNullableString(input.connection?.usernameEnv),
      usernameValue: normalizeNullableString(input.connection?.usernameValue),
      passwordEnv: normalizeNullableString(input.connection?.passwordEnv),
      passwordValue: normalizeNullableString(input.connection?.passwordValue),
      uriTemplate: normalizeNullableString(input.connection?.uriTemplate),
      notes: normalizeNullableString(input.connection?.notes)
    }
  };
}

function serializeTemplate(template: LoadedServiceTemplate): ServiceTemplateInput {
  return {
    id: template.id,
    label: template.label,
    description: template.description,
    runtimeKind: template.runtimeKind,
    engine: template.engine,
    image: template.image,
    port: template.defaultPort,
    notes: template.notes ?? undefined,
    command: template.command ?? undefined,
    workingDir: template.workingDir ?? undefined,
    envDefaults: template.envDefaults,
    fileName: template.fileName ?? undefined,
    stackVolumePath: template.stackVolumePath ?? undefined,
    connection: {
      databaseEnv: template.connection.databaseEnv ?? undefined,
      databaseValue: template.connection.databaseValue ?? undefined,
      usernameEnv: template.connection.usernameEnv ?? undefined,
      usernameValue: template.connection.usernameValue ?? undefined,
      passwordEnv: template.connection.passwordEnv ?? undefined,
      passwordValue: template.connection.passwordValue ?? undefined,
      uriTemplate: template.connection.uriTemplate ?? undefined,
      notes: template.connection.notes ?? undefined
    }
  };
}

function buildDefaultTemplateMap(): Map<string, LoadedServiceTemplate> {
  return new Map(
    DEFAULT_TEMPLATE_INPUTS
      .map(normalizeTemplateInput)
      .filter((entry): entry is LoadedServiceTemplate => Boolean(entry))
      .map((template) => [template.id, template])
  );
}

export class ServiceTemplateRegistry {
  private readonly defaults = buildDefaultTemplateMap();
  private readonly persisted = new Map<string, LoadedServiceTemplate>();

  constructor(private readonly statePath: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    this.persisted.clear();
    const raw = await fs.readFile(this.statePath, "utf8").catch(() => "");
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as { templates?: ServiceTemplateInput[] } | ServiceTemplateInput[];
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.templates) ? parsed.templates : [];
    for (const entry of entries) {
      const normalized = normalizeTemplateInput(entry);
      if (normalized) {
        this.persisted.set(normalized.id, normalized);
      }
    }
  }

  list(): LoadedServiceTemplate[] {
    const merged = new Map(this.defaults);
    for (const [id, template] of this.persisted.entries()) {
      merged.set(id, template);
    }

    return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  get(templateId: string): LoadedServiceTemplate | undefined {
    const id = templateId.trim().toLowerCase();
    return this.persisted.get(id) ?? this.defaults.get(id);
  }

  async upsert(input: ServiceTemplateInput): Promise<LoadedServiceTemplate> {
    const normalized = normalizeTemplateInput(input);
    if (!normalized) {
      throw new Error("Invalid service template");
    }

    this.persisted.set(normalized.id, normalized);
    await this.save();
    return normalized;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const payload = {
      templates: [...this.persisted.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((template) => serializeTemplate(template))
    };
    await fs.writeFile(this.statePath, JSON.stringify(payload, null, 2));
  }
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
    ttlAnchorAt: input.updatedAt,
    leaseTtlMs: null,
    expiresAt: null,
    expiredAt: null,
    reapAfterAt: null,
    lifecycleState: "active",
    connection: buildServiceConnection(input.template, input.targetHost, input.targetPort, input.env, input.worktreePath)
  };
}
