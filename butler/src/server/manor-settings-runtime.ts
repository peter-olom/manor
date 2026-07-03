import { promises as fs, statSync } from "node:fs";

import type { ManorSettings, SettingsSecretSource } from "../shared/settings.js";
import { buildManorSettingsFromEnv, cloneManorSettings } from "./manor-settings-schema.js";
import type { ManorSettingsService } from "./manor-settings-service.js";

let activeSettingsService: ManorSettingsService | null = null;
let activeSettings: ManorSettings | null = null;

export function setActiveManorSettingsService(service: ManorSettingsService | null): void {
  activeSettingsService = service;
  activeSettings = service?.getSettings() ?? null;
  service?.on("change", (settings) => {
    activeSettings = settings;
  });
}

export function setActiveManorSettings(settings: ManorSettings | null): void {
  activeSettings = settings ? cloneManorSettings(settings) : null;
}

export function getActiveManorSettings(env: NodeJS.ProcessEnv = process.env): ManorSettings {
  if (env === process.env && activeSettings) return cloneManorSettings(activeSettings);
  return buildManorSettingsFromEnv(env).settings;
}

export function getActiveManorSettingsService(): ManorSettingsService | null {
  return activeSettingsService;
}

export async function readSecretSourceValue(source: SettingsSecretSource, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (source.type === "env") {
    const value = env[source.name]?.trim();
    return value || null;
  }
  if (source.type === "file") {
    const filePath = env[source.pathEnv]?.trim();
    if (!filePath) return null;
    const content = await fs.readFile(filePath, "utf8").catch(() => "");
    return content.trim() || null;
  }
  return null;
}

export function isSecretSourceAvailable(source: SettingsSecretSource, env: NodeJS.ProcessEnv = process.env): boolean {
  if (source.type === "env") {
    return Boolean(env[source.name]?.trim());
  }
  if (source.type === "file") {
    const filePath = env[source.pathEnv]?.trim();
    if (!filePath) return false;
    try {
      return Boolean(statSync(filePath).isFile());
    } catch {
      return false;
    }
  }
  return false;
}
