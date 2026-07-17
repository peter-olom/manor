import type { SkillCatalogItem, SkillEnvironmentId } from "./skills-service.js";

export const SKILL_ENVIRONMENTS: readonly SkillEnvironmentId[] = ["butler-pi", "worker-pi"];

export type ManorSkillCapability = {
  name: string;
  description: string;
  environments: SkillEnvironmentId[];
};

type SkillCatalogReader = {
  list(environment: SkillEnvironmentId, cwd?: string | null): Promise<SkillCatalogItem[]>;
};

export async function listManorSkillCapabilities(reader: SkillCatalogReader, cwd?: string | null): Promise<ManorSkillCapability[]> {
  const catalogs = await Promise.all(SKILL_ENVIRONMENTS.map(async (environment) => ({
    environment,
    skills: await reader.list(environment, cwd).catch(() => [])
  })));
  const merged = new Map<string, ManorSkillCapability>();
  for (const { environment, skills } of catalogs) {
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        if (!existing.environments.includes(environment)) existing.environments.push(environment);
        if (!existing.description && skill.description) existing.description = skill.description;
      } else {
        merged.set(key, { name: skill.name, description: skill.description, environments: [environment] });
      }
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function skillEnvironmentLabel(environment: SkillEnvironmentId): string {
  if (environment === "butler-pi") return "Butler";
  return "Worker";
}

export function skillAvailabilityDetail(skill: ManorSkillCapability): string {
  const availability = skill.environments.map(skillEnvironmentLabel).join(", ");
  return [skill.description, `Available in ${availability}`].filter(Boolean).join(" · ");
}

export function normalizeManorSkillName(value: string): string | null {
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : null;
}

export function parseManorSkillInvocation(text: string): { name: string; task: string } | null {
  const match = text.match(/^\s*\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  const name = normalizeManorSkillName(match[1]);
  if (!name) throw new Error("Skill invocation has an invalid name.");
  return { name, task: match[2]?.trim() ?? "" };
}

export function buildManorSkillRoutingContext(
  name: string,
  environments: SkillEnvironmentId[],
  targetWorkerEnvironment: Exclude<SkillEnvironmentId, "butler-pi">
): string {
  const available = environments.length > 0 ? environments.map(skillEnvironmentLabel).join(", ") : "none";
  const targetHasSkill = environments.includes(targetWorkerEnvironment);
  const butlerHasSkill = environments.includes("butler-pi");
  const workerInvocation = `/skill:${name}`;
  return [
    "MANOR-WIDE SKILL ROUTING",
    `Selected capability: ${name}`,
    `Available in: ${available}`,
    `Selected Worker target: ${skillEnvironmentLabel(targetWorkerEnvironment)}`,
    `Butler availability: ${butlerHasSkill ? "installed" : "not installed"}`,
    `Selected Worker availability: ${targetHasSkill ? "installed" : "not installed"}`,
    "Treat this as one Manor capability request. The operator does not manage agent-environment boundaries.",
    targetHasSkill
      ? `For execution work, delegate to the selected Worker and include its native invocation ${workerInvocation} in the Worker task.`
      : `Before execution work, inspect an installed copy if one exists, propose installing the exact skill in ${targetWorkerEnvironment}, wait for approval, apply and verify it, then delegate with ${workerInvocation}.`,
    environments.length === 0
      ? "No Manor environment currently has this skill. Find or obtain a trustworthy complete SKILL.md, propose installation for the selected Worker, wait for approval, apply and verify it, then delegate."
      : "Do not ask the operator to choose an environment when the selected Worker target is already known.",
    "Never claim a worker-only skill is unavailable merely because Butler itself does not have it."
  ].join("\n");
}
