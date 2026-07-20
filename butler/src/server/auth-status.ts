import { promises as fs } from "node:fs";

import type { ButlerAuthStatus } from "./types.js";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function buildAuthStatus(
  mode: ButlerAuthStatus["mode"],
  loggedIn: boolean,
  validationError: string | null = null
): ButlerAuthStatus {
  return {
    mode,
    loggedIn,
    validationError,
    lastValidatedAt: Date.now()
  };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const authClaim = payload?.[JWT_CLAIM_PATH];
  if (!authClaim || typeof authClaim !== "object") {
    return null;
  }

  const accountId = (authClaim as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function validateChatGptAuth(accessToken: string | undefined, refreshToken: string | undefined): ButlerAuthStatus {
  if (!accessToken || !refreshToken) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT credentials are incomplete.");
  }

  if (!getAccountId(accessToken)) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT access token is missing the expected account binding.");
  }

  // Pi owns token expiry checks, locked refresh, and credential rotation when a
  // model request needs authentication. This local status must stay read-only.
  return buildAuthStatus("chatgpt", true);
}

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
        expires?: number;
        accountId?: string;
      };
    };

    if (data["openai-codex"]?.type === "oauth") {
      return validateChatGptAuth(data["openai-codex"].access, data["openai-codex"].refresh);
    }

    if (data.openai?.type === "api_key" && data.openai?.key) {
      return buildAuthStatus("api", true);
    }

    return buildAuthStatus("none", false);
  } catch {
    return buildAuthStatus("none", false);
  }
}
