#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CALLBACK_PORT = 1455;

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState() {
  return randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined
    };
  } catch {
    // Not a URL.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined
    };
  }

  return { code: value };
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function exchangeAuthorizationCode(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed with ${response.status}: ${text || "no response body"}`);
  }

  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token response was missing expected fields.");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000
  };
}

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function buildAuthorizationUrl(state, challenge) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "pi");
  return url.toString();
}

async function startCallbackServer(expectedState) {
  let settleWait;
  const waitForCode = new Promise((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (state !== expectedState) {
        response.statusCode = 400;
        response.end("State mismatch");
        return;
      }

      if (!code) {
        response.statusCode = 400;
        response.end("Missing authorization code");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<html><body><p>Butler ChatGPT login completed. You can close this window.</p></body></html>");
      settleWait({ code });
    } catch {
      response.statusCode = 500;
      response.end("OAuth callback error");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(CALLBACK_PORT, "0.0.0.0", () => {
        resolve({
          available: true,
          close: () => server.close(),
          waitForCode: () => waitForCode
        });
      })
      .on("error", () => {
        resolve({
          available: false,
          close: () => {
            try {
              server.close();
            } catch {
              // Ignore.
            }
          },
          waitForCode: async () => null
        });
      });
  });
}

function createManualInputPrompt() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    rl.close();
  };

  const promise = rl
    .question("If the browser cannot complete the callback, paste the final redirect URL or code here and press Enter:\n> ")
    .catch(() => "")
    .finally(close);

  return { promise, close };
}

async function loadAuth(authPath) {
  try {
    return JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch {
    return {};
  }
}

async function saveAuth(authPath, entry) {
  const current = await loadAuth(authPath);
  current["openai-codex"] = entry;

  await fs.mkdir(path.dirname(authPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const piAgentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const authPath = path.join(piAgentDir, "auth.json");

  const { verifier, challenge } = generatePkce();
  const state = createState();
  const loginUrl = buildAuthorizationUrl(state, challenge);
  const server = await startCallbackServer(state);

  console.log("Open this URL in your browser:");
  console.log(loginUrl);
  console.log("");
  if (server.available) {
    console.log("Waiting for the browser callback on localhost:1455.");
  } else {
    console.log("Local callback port is unavailable. Use manual paste after login.");
  }
  console.log("");
  const manual = createManualInputPrompt();

  try {
    const first = await Promise.race([
      server.waitForCode().then((value) => ({ type: "callback", value })),
      manual.promise.then((value) => ({ type: "manual", value }))
    ]);

    let code;
    if (first.type === "callback" && first.value?.code) {
      code = first.value.code;
    } else if (first.type === "manual") {
      const parsed = parseAuthorizationInput(first.value);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch. Start the login again and paste the latest redirect URL.");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("No authorization code was received.");
    }

    const tokens = await exchangeAuthorizationCode(code, verifier);
    const accountId = getAccountId(tokens.access);
    if (!accountId) {
      throw new Error("Failed to extract the ChatGPT account id from the token.");
    }

    await saveAuth(authPath, {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId
    });

    console.log("Butler ChatGPT login saved.");
  } finally {
    manual.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
