import { promises as fs } from "node:fs";

import type { ButlerAuthStatus } from "./types.js";

export async function readButlerAuthStatus(piAuthPath: string): Promise<ButlerAuthStatus> {
  try {
    const raw = await fs.readFile(piAuthPath, "utf8");
    const data = JSON.parse(raw) as {
      openai?: {
        type?: string;
        key?: string;
      };
      "openai-codex"?: {
        type?: string;
        access?: string;
        refresh?: string;
      };
    };

    if (data["openai-codex"]?.type === "oauth" && data["openai-codex"]?.access && data["openai-codex"]?.refresh) {
      return { mode: "chatgpt", loggedIn: true };
    }

    if (data.openai?.type === "api_key" && data.openai?.key) {
      return { mode: "api", loggedIn: true };
    }

    return { mode: "none", loggedIn: false };
  } catch {
    return { mode: "none", loggedIn: false };
  }
}
