import path from "node:path";
import { promises as fs } from "node:fs";

import { resolveGitRoot } from "./repo-worktree.js";

export type WorkspacePackageManagerName = "yarn" | "pnpm" | "npm" | "bun";

export interface WorkspaceBootstrapView {
  cwd: string;
  workspaceRoot: string | null;
  ecosystem: "node" | "unknown";
  packageJsonPath: string | null;
  packageManager: {
    name: WorkspacePackageManagerName;
    version: string | null;
    raw: string | null;
    viaCorepack: boolean;
    vendored: boolean;
  } | null;
  nodeVersion: string | null;
  installState: "ready" | "missing" | "unknown";
  needsPackageManagerDownload: boolean;
  suggestedPreview: {
    image: string | null;
    bootstrapHint: string | null;
    egressDomains: string[];
    suggestedInstallCommand: string | null;
  } | null;
  notes: string[];
}

type PackageJsonShape = {
  packageManager?: string;
  engines?: {
    node?: string;
  };
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function parsePackageManager(rawValue: string | null | undefined): {
  name: WorkspacePackageManagerName;
  version: string | null;
  raw: string;
  viaCorepack: boolean;
} | null {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return null;
  }

  const raw = rawValue.trim();
  const marker = raw.indexOf("@");
  const name = (marker === -1 ? raw : raw.slice(0, marker)).trim();
  const version =
    marker === -1
      ? null
      : raw
          .slice(marker + 1)
          .trim()
          .replace(/\+sha\d+.*$/i, "") || null;

  if (name !== "yarn" && name !== "pnpm" && name !== "npm" && name !== "bun") {
    return null;
  }

  return {
    name,
    version,
    raw,
    viaCorepack: name === "yarn" || name === "pnpm"
  };
}

function inferPackageManagerFromFiles(files: Set<string>): WorkspacePackageManagerName | null {
  if (files.has("yarn.lock")) {
    return "yarn";
  }
  if (files.has("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) {
    return "npm";
  }
  if (files.has("bun.lock") || files.has("bun.lockb")) {
    return "bun";
  }
  return null;
}

async function findNearestPackageJson(startCwd: string, gitRoot: string | null): Promise<string | null> {
  const normalizedStart = normalizePath(startCwd);
  if (!normalizedStart) {
    return null;
  }

  const normalizedGitRoot = normalizePath(gitRoot);
  let current = normalizedStart;

  while (current) {
    const candidate = path.join(current, "package.json");
    if (await pathExists(candidate)) {
      return candidate;
    }

    if (normalizedGitRoot && current === normalizedGitRoot) {
      break;
    }

    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return null;
}

async function detectNodeWorkspaceRoot(startCwd: string): Promise<{ root: string; packageJsonPath: string } | null> {
  const gitRoot = await resolveGitRoot(startCwd).catch(() => null);
  const normalizedGitRoot = normalizePath(gitRoot);
  if (normalizedGitRoot && (await pathExists(path.join(normalizedGitRoot, "package.json")))) {
    return {
      root: normalizedGitRoot,
      packageJsonPath: path.join(normalizedGitRoot, "package.json")
    };
  }

  const nearest = await findNearestPackageJson(startCwd, normalizedGitRoot);
  if (!nearest) {
    return null;
  }

  return {
    root: path.dirname(nearest),
    packageJsonPath: nearest
  };
}

async function readNodeVersion(workspaceRoot: string, pkg: PackageJsonShape | null): Promise<string | null> {
  const packageVersion = pkg?.engines?.node?.trim();
  if (packageVersion) {
    return packageVersion;
  }

  const versionFiles = [".node-version", ".nvmrc"];
  for (const fileName of versionFiles) {
    const content = await fs.readFile(path.join(workspaceRoot, fileName), "utf8").catch(() => "");
    const trimmed = content.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  const toolVersions = await fs.readFile(path.join(workspaceRoot, ".tool-versions"), "utf8").catch(() => "");
  if (toolVersions) {
    const match = toolVersions.match(/^nodejs\s+(.+)$/m);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  const miseToml = await fs.readFile(path.join(workspaceRoot, "mise.toml"), "utf8").catch(() => "");
  if (miseToml) {
    const match = miseToml.match(/node(?:js)?\s*=\s*["']([^"']+)["']/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

async function hasVendoredYarn(workspaceRoot: string): Promise<boolean> {
  const releasesDir = path.join(workspaceRoot, ".yarn", "releases");
  const releaseEntries = await fs.readdir(releasesDir).catch(() => []);
  if (releaseEntries.length > 0) {
    return true;
  }

  const yarnRc = await fs.readFile(path.join(workspaceRoot, ".yarnrc.yml"), "utf8").catch(() => "");
  return /(^|\n)\s*yarnPath\s*:/m.test(yarnRc);
}

async function detectInstallState(workspaceRoot: string, managerName: WorkspacePackageManagerName | null): Promise<"ready" | "missing" | "unknown"> {
  if (await pathExists(path.join(workspaceRoot, "node_modules"))) {
    return "ready";
  }

  if (await pathExists(path.join(workspaceRoot, ".pnp.cjs"))) {
    return "ready";
  }

  if (await pathExists(path.join(workspaceRoot, ".pnp.loader.mjs"))) {
    return "ready";
  }

  if (managerName === "yarn" && (await pathExists(path.join(workspaceRoot, ".yarn", "install-state.gz")))) {
    return "ready";
  }

  if (await pathExists(path.join(workspaceRoot, "package.json"))) {
    return "missing";
  }

  return "unknown";
}

function buildSuggestedInstallCommand(manager: WorkspaceBootstrapView["packageManager"]): string | null {
  if (!manager) {
    return null;
  }

  if (manager.name === "yarn") {
    return "corepack yarn install";
  }
  if (manager.name === "pnpm") {
    return "corepack pnpm install";
  }
  if (manager.name === "npm") {
    return "npm install";
  }
  if (manager.name === "bun") {
    return "bun install";
  }
  return null;
}

function describeManager(manager: WorkspaceBootstrapView["packageManager"]): string | null {
  if (!manager) {
    return null;
  }
  return manager.version ? `${manager.name}@${manager.version}` : manager.name;
}

export async function inspectWorkspaceBootstrap(cwd: string | null | undefined): Promise<WorkspaceBootstrapView | null> {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd) {
    return null;
  }

  const nodeWorkspace = await detectNodeWorkspaceRoot(normalizedCwd);
  if (!nodeWorkspace) {
    return {
      cwd: normalizedCwd,
      workspaceRoot: null,
      ecosystem: "unknown",
      packageJsonPath: null,
      packageManager: null,
      nodeVersion: null,
      installState: "unknown",
      needsPackageManagerDownload: false,
      suggestedPreview: null,
      notes: []
    };
  }

  const pkg = await readJsonFile<PackageJsonShape>(nodeWorkspace.packageJsonPath);
  const discoveredLockfiles = await Promise.all(
    ["yarn.lock", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb"].map(async (fileName) =>
      (await pathExists(path.join(nodeWorkspace.root, fileName))) ? fileName : null
    )
  );
  const lockfiles = new Set(discoveredLockfiles.filter((value): value is string => Boolean(value)));

  const parsedPackageManager = parsePackageManager(pkg?.packageManager);
  const inferredManagerName = parsedPackageManager?.name ?? inferPackageManagerFromFiles(lockfiles);
  const vendoredYarn = inferredManagerName === "yarn" ? await hasVendoredYarn(nodeWorkspace.root) : false;
  const packageManager =
    parsedPackageManager || inferredManagerName
      ? {
          name: parsedPackageManager?.name ?? inferredManagerName!,
          version: parsedPackageManager?.version ?? null,
          raw: parsedPackageManager?.raw ?? null,
          viaCorepack: parsedPackageManager?.viaCorepack ?? (inferredManagerName === "yarn" || inferredManagerName === "pnpm"),
          vendored: vendoredYarn
        }
      : null;
  const installState = await detectInstallState(nodeWorkspace.root, packageManager?.name ?? null);
  const nodeVersion = await readNodeVersion(nodeWorkspace.root, pkg);

  const needsPackageManagerDownload = Boolean(packageManager?.viaCorepack && !packageManager.vendored);
  const managerDescription = describeManager(packageManager);
  const notes: string[] = [];

  if (installState === "missing") {
    notes.push("Dependencies are not installed in this workspace.");
  }
  if (needsPackageManagerDownload && managerDescription) {
    notes.push(`${managerDescription} will need to be bootstrapped before the app command can run.`);
  }
  if (installState === "missing" || needsPackageManagerDownload) {
    notes.push(
      "If runtime execution is required, do any repo prep explicitly first, then use preview runtime as the main dev box for startup, logs, and verification."
    );
  }

  const bootstrapHint =
    installState === "missing" && managerDescription
      ? `installing deps with ${managerDescription}`
      : needsPackageManagerDownload && managerDescription
        ? `bootstrapping ${managerDescription}`
        : null;

  return {
    cwd: normalizedCwd,
    workspaceRoot: nodeWorkspace.root,
    ecosystem: "node",
    packageJsonPath: nodeWorkspace.packageJsonPath,
    packageManager,
    nodeVersion,
    installState,
    needsPackageManagerDownload,
    suggestedPreview: {
      image: "node:22-bookworm",
      bootstrapHint,
      egressDomains: [],
      suggestedInstallCommand: buildSuggestedInstallCommand(packageManager)
    },
    notes
  };
}

export function formatWorkspaceBootstrapLines(bootstrap: WorkspaceBootstrapView | null): string[] {
  if (!bootstrap || bootstrap.ecosystem === "unknown") {
    return ["Workspace bootstrap: no runtime bootstrap hints detected."];
  }

  const managerDescription = describeManager(bootstrap.packageManager) ?? "unknown";
  const installDescription =
    bootstrap.installState === "ready" ? "ready" : bootstrap.installState === "missing" ? "missing" : "unknown";
  const lines = [
    `Workspace bootstrap: ${bootstrap.ecosystem} | manager=${managerDescription} | install=${installDescription}${bootstrap.nodeVersion ? ` | node=${bootstrap.nodeVersion}` : ""}`
  ];

  const suggestedPreview = bootstrap.suggestedPreview;
  if (suggestedPreview) {
    const previewBits = [
      suggestedPreview.image ? `image=${suggestedPreview.image}` : null,
      suggestedPreview.bootstrapHint ? `hint=${suggestedPreview.bootstrapHint}` : null,
      "outbound=direct internet"
    ].filter(Boolean);
    lines.push(`Preview hints: ${previewBits.join(" | ")}`);
    if (suggestedPreview.suggestedInstallCommand) {
      lines.push(`Suggested install step: ${suggestedPreview.suggestedInstallCommand}`);
    }
  }

  for (const note of bootstrap.notes) {
    lines.push(`Note: ${note}`);
  }

  return lines;
}

export function applyWorkspacePreviewDefaults(
  input: {
    image?: string | undefined;
    egressProfile?: string | undefined;
    egressDomains?: string[] | undefined;
    bootstrapHint?: string | undefined;
  },
  bootstrap: WorkspaceBootstrapView | null
): {
  image?: string | undefined;
  egressProfile?: string | undefined;
  egressDomains?: string[] | undefined;
  bootstrapHint?: string | undefined;
  autofilled: string[];
} {
  const next = {
    image: input.image,
    egressProfile: input.egressProfile,
    egressDomains: input.egressDomains,
    bootstrapHint: input.bootstrapHint
  };
  const autofilled: string[] = [];
  const suggestedPreview = bootstrap?.suggestedPreview;

  if (suggestedPreview?.image && !next.image) {
    next.image = suggestedPreview.image;
    autofilled.push("image");
  }

  if (suggestedPreview?.bootstrapHint && !next.bootstrapHint) {
    next.bootstrapHint = suggestedPreview.bootstrapHint;
    autofilled.push("bootstrapHint");
  }

  return {
    ...next,
    autofilled
  };
}
