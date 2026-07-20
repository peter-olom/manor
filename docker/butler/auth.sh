#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  butler-auth bootstrap
  butler-auth status
  butler-auth api-key
  butler-auth device
EOF
}

read_api_key() {
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    printf '%s' "${OPENAI_API_KEY}"
    return 0
  fi

  if [[ -n "${OPENAI_API_KEY_FILE:-}" ]]; then
    if [[ ! -r "${OPENAI_API_KEY_FILE}" ]]; then
      echo "OPENAI_API_KEY_FILE is not readable." >&2
      return 1
    fi

    tr -d '\r' < "${OPENAI_API_KEY_FILE}"
    return 0
  fi

  return 1
}

login_status() {
  PI_CODING_AGENT_DIR="${PI_AGENT_DIR}" NODE_NO_WARNINGS=1 node <<'EOF'
const fs = require("fs");
const path = require("path");

const authPath = path.join(process.env.PI_AGENT_DIR || "", "auth.json");
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

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

function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function main() {
  const data = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const codexAuth = data["openai-codex"];

  if (codexAuth?.type === "oauth") {
    if (codexAuth.access && codexAuth.refresh && getAccountId(codexAuth.access)) {
      console.log("Logged in to Butler using ChatGPT.");
      process.exit(0);
    }
    console.log("Butler ChatGPT credentials are incomplete. Sign in again.");
    process.exit(1);
  }

  if (data.openai?.type === "api_key" && data.openai?.key) {
    console.log("Logged in to Butler using an API key.");
    process.exit(0);
  }

  console.log("Not logged in.");
}

try {
  main();
} catch {
  console.log("Not logged in.");
}
EOF
}

write_api_key_auth() {
  local api_key
  api_key="$(read_api_key)"

  PI_CODING_AGENT_DIR="${PI_AGENT_DIR}" OPENAI_API_KEY_VALUE="${api_key}" NODE_NO_WARNINGS=1 node <<'EOF'
const fs = require("fs");
const path = require("path");

const agentDir = process.env.PI_AGENT_DIR;
const authPath = path.join(agentDir, "auth.json");
const apiKey = process.env.OPENAI_API_KEY_VALUE;
let auth = {};

fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

try {
  auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
} catch {}

auth.openai = {
  type: "api_key",
  key: apiKey
};

fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
EOF
}

bootstrap_api_key() {
  local status
  status="$(login_status || true)"

  if grep -Eq "Logged in to Butler using an API key" <<<"${status}"; then
    return 0
  fi

  if ! grep -q "Not logged in" <<<"${status}"; then
    echo "Skipping API key bootstrap because Butler already has cached non-API credentials." >&2
    return 0
  fi

  write_api_key_auth
}

command_name="${1:-}"

mkdir -p "${PI_AGENT_DIR:-$HOME/.pi/agent}"

case "${command_name}" in
  bootstrap)
    forced_login_method="${BUTLER_FORCED_LOGIN_METHOD:-}"
    bootstrap_mode="${BUTLER_AUTH_BOOTSTRAP:-auto}"

    if [[ "${forced_login_method}" != "chatgpt" ]]; then
      case "${bootstrap_mode}" in
        auto|api-key)
          if read_api_key >/dev/null 2>&1; then
            bootstrap_api_key
          fi
          ;;
        none|disabled|off)
          ;;
        *)
          echo "Unsupported BUTLER_AUTH_BOOTSTRAP value: ${bootstrap_mode}" >&2
          exit 64
          ;;
      esac
    fi
    ;;
  status)
    login_status
    ;;
  api-key)
    write_api_key_auth
    ;;
  device)
    exec env NODE_NO_WARNINGS=1 BUTLER_APP_DIR="${BUTLER_APP_DIR:-/opt/manor/butler}" node /usr/local/bin/butler-chatgpt-login.mjs
    ;;
  *)
    usage
    exit 64
    ;;
esac
