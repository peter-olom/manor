import { Buffer } from "node:buffer";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|access[_-]?key[_-]?id|storage[_-]?key|subscription[_-]?key|private[_-]?key|signing[_-]?secret|webhook[_-]?secret|session[_-]?secret|password|passwd|token|secret)`;
const SENSITIVE_ASSIGNMENT = new RegExp(
  `(^|[^A-Za-z0-9_-])(["']?${SENSITIVE_KEY_NAME}["']?)(\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*'|[^\\s"',;}&\\[\\]\\}\\r\\n]+)`,
  "gim"
);
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g;
const AUTHORIZATION_CREDENTIAL = /((?:["']?)(?:proxy-)?authorization(?:["']?)\s*[:=]\s*(?:["']?))(bearer|basic)\s+([^"'\s,;}\[\]]+)/gi;
const STANDALONE_BEARER = /\b(Bearer)\s+([A-Za-z0-9_~+\/-][A-Za-z0-9._~+\/-]{6,}[A-Za-z0-9_~+\/-]={0,2})/gi;
const STANDALONE_BASIC = /\b(Basic)\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{5,}){0,2}\b/g;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GOOGLE_CREDENTIAL = /\b(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/g;
const URL_CREDENTIALS = /:\/\/([^:\s\/@?#]+):([^@\s\/?#]+)@/g;
const SIGNED_URL_CREDENTIAL = /([?&](?:authorization|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature)|signature|sig)=)([^&#\s]+)/gi;
const STREAMING_SENSITIVE_ASSIGNMENT = new RegExp(
  `(^|[^A-Za-z0-9_-])(["']?${SENSITIVE_KEY_NAME}["']?)(\\s*[:=]\\s*)(["'])([^\\r\\n]*)$`,
  "gim"
);
const STREAMING_AUTH_CREDENTIAL = /\b(Bearer|Basic)\s+[^\s"',;}\[\]]+/gi;
const STREAMING_TOKEN_CANDIDATE = /\b(?:sk-[A-Za-z0-9_-]*|gh[pousr]_[A-Za-z0-9_]*|github_pat_[A-Za-z0-9_]*|(?:AKIA|ASIA)[A-Z0-9]*|AIza[0-9A-Za-z_-]*|ya29\.[0-9A-Za-z_-]*|eyJ[A-Za-z0-9._-]*)/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/g;

function redactAssignment(
  match: string,
  leading: string,
  key: string,
  separator: string,
  value: string
): string {
  if (value.startsWith("-----BEGIN")) return match;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${leading}${key}${separator}${quote}${REDACTED}${quote}`;
}

function redactPrivateKey(_match: string, label: string): string {
  return `-----BEGIN ${label}-----\n${REDACTED}\n-----END ${label}-----`;
}

function redactStandaloneBearer(match: string, scheme: string, credential: string): string {
  const looksOpaque = credential.length >= 12 && /[0-9._~+\/-]/.test(credential);
  return looksOpaque ? `${scheme} ${REDACTED}` : match;
}

function redactStandaloneBasic(match: string, scheme: string, credential: string): string {
  try {
    const normalized = credential.replace(/=+$/, "");
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    const roundTrip = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "");
    return decoded.includes(":") && roundTrip === normalized ? `${scheme} ${REDACTED}` : match;
  } catch {
    return match;
  }
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(SENSITIVE_ASSIGNMENT, redactAssignment)
    .replace(PRIVATE_KEY_BLOCK, redactPrivateKey)
    .replace(AUTHORIZATION_CREDENTIAL, (_match, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`)
    .replace(STANDALONE_BEARER, redactStandaloneBearer)
    .replace(STANDALONE_BASIC, redactStandaloneBasic)
    .replace(URL_CREDENTIALS, `://${REDACTED}@`)
    .replace(SIGNED_URL_CREDENTIAL, `$1${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(OPENAI_TOKEN, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(AWS_ACCESS_KEY_ID, REDACTED)
    .replace(GOOGLE_CREDENTIAL, REDACTED);
}

function redactIncompletePrivateKeyTail(text: string): string {
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRIVATE_KEY_BEGIN.exec(text)) !== null) {
    const endMarker = `-----END ${match[1]}-----`;
    if (!text.slice(match.index + match[0].length).includes(endMarker)) {
      return `${text.slice(0, match.index)}${match[0]}\n${REDACTED}`;
    }
  }
  return text;
}

/**
 * Redacts reasoning while it is still streaming. The broader matches are
 * intentional: a partial quoted assignment or token prefix must be hidden
 * before later deltas make it recognizable to the normal redactor.
 */
export function redactLiveReasoningText(text: string): string {
  return redactSensitiveText(redactIncompletePrivateKeyTail(text)
    .replace(STREAMING_SENSITIVE_ASSIGNMENT, (match, leading: string, key: string, separator: string, quote: string, value: string) =>
      value.includes(quote) ? match : `${leading}${key}${separator}${quote}${REDACTED}${quote}`)
    .replace(STREAMING_AUTH_CREDENTIAL, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(STREAMING_TOKEN_CANDIDATE, REDACTED));
}

/**
 * Holds back the current non-whitespace token. A token split across provider
 * deltas is therefore redacted before any part of it becomes operator-visible.
 */
export function redactLiveReasoningPreview(text: string): string {
  const redacted = redactLiveReasoningText(text);
  for (let index = redacted.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(redacted[index]!)) return redacted.slice(0, index + 1);
  }
  return "";
}
