export const SKILL_INSTALL_HANDOFF_EVENT = "manor:skill-install-handoff";
export const SKILL_INSTALL_HANDOFF_PLACEHOLDER = "Describe the skill or capability you want Butler to add…";

export function shouldCreateSkillInstallSession(activeSessionId: string | null, creating = false): boolean {
  return activeSessionId === null && !creating;
}

export function dispatchSkillInstallHandoff(target: EventTarget = window): void {
  target.dispatchEvent(new Event(SKILL_INSTALL_HANDOFF_EVENT));
}

export function listenForSkillInstallHandoff(listener: EventListener, target: EventTarget = window): () => void {
  target.addEventListener(SKILL_INSTALL_HANDOFF_EVENT, listener);
  return () => target.removeEventListener(SKILL_INSTALL_HANDOFF_EVENT, listener);
}

export function readSkillInstallHandoff(search: string): boolean {
  return new URLSearchParams(search).get("ask") === "add-skill";
}

export function removeSkillInstallHandoff(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("ask");
  return `${url.pathname}${url.search}${url.hash}`;
}
