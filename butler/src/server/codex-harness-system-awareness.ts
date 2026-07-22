import {
  formatManorSystemAwareness,
  MANOR_AWARENESS_SECTIONS,
  type ManorAwarenessSection,
  type ManorSystemAwarenessReader
} from "./manor-system-awareness.js";

export async function handleHarnessSystemAwareness(input: {
  action: string;
  section: string;
  workerThreadId: string;
  workerEffort: string | null;
  read: ManorSystemAwarenessReader | null;
}): Promise<{ text: string; data: Record<string, unknown> } | null> {
  if (input.action !== "system.awareness") return null;
  if (!input.read) throw new Error("Manor system awareness is unavailable.");
  const section = input.section || "overview";
  if (!(MANOR_AWARENESS_SECTIONS as readonly string[]).includes(section)) throw new Error("Unsupported Manor awareness section.");
  const snapshot = await input.read(section as ManorAwarenessSection, { workerThreadId: input.workerThreadId, workerEffort: input.workerEffort });
  return { text: formatManorSystemAwareness(snapshot), data: { snapshot } };
}
