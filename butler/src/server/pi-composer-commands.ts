import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type PiComposerCommand = {
  name: string;
  description: string | null;
  source: "extension" | "prompt";
};

export function listPiComposerCommands(session: AgentSession | null): PiComposerCommand[] {
  if (!session) return [];
  const extensions = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description ?? null,
    source: "extension" as const
  }));
  const prompts = session.promptTemplates.map((prompt) => ({
    name: prompt.name,
    description: prompt.description || null,
    source: "prompt" as const
  }));
  const seen = new Set<string>();
  return [...extensions, ...prompts].filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}
