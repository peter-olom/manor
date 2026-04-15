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

function getExpiry(accessToken: string): number | null {
  const payload = decodeJwt(accessToken);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

function validateChatGptAuth(accessToken: string | undefined, refreshToken: string | undefined): ButlerAuthStatus {
  if (!accessToken || !refreshToken) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT credentials are incomplete.");
  }

  const expiresAt = getExpiry(accessToken);
  if (!expiresAt) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT access token could not be decoded.");
  }

  if (expiresAt <= Date.now() + 60_000) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT access token is expired or about to expire.");
  }

  if (!getAccountId(accessToken)) {
    return buildAuthStatus("chatgpt", false, "Stored ChatGPT access token is missing the expected account binding.");
  }

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

export async function readCodexAuthStatus(codexAuthPath: string): Promise<ButlerAuthStatus> {
  try {
    const raw = await fs.readFile(codexAuthPath, "utf8");
    const data = JSON.parse(raw) as {
      auth_mode?: string | null;
      OPENAI_API_KEY?: string | null;
      last_refresh?: number | null;
      tokens?: {
        access_token?: string;
        refresh_token?: string;
      };
    };

    if (data.auth_mode === "chatgpt") {
      return validateChatGptAuth(data.tokens?.access_token, data.tokens?.refresh_token);
    }

    if (data.auth_mode === "api" && data.OPENAI_API_KEY) {
      return buildAuthStatus("api", true);
    }

    return buildAuthStatus("none", false);
  } catch {
    return buildAuthStatus("none", false);
  }
}
