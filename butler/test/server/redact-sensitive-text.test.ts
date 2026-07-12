import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText } from "../../src/server/redact-sensitive-text.js";

test("persisted Butler diagnostics redact common credential forms", () => {
  const text = redactSensitiveText("Authorization: Bearer abc.def.ghi api_key=secret-value password: hunter2 token ghp_abcdefghijklmnopqrstuvwxyz https://user:pass@example.com");

  assert.doesNotMatch(text, /abc\.def|secret-value|hunter2|ghp_|user:pass/);
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.match(text, /api_key=\[REDACTED\]/);
  assert.match(text, /password: \[REDACTED\]/);
});

test("authorization headers, standalone schemes, and JWTs are redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const text = redactSensitiveText([
    '"Authorization": "Basic dXNlcjpwYXNz"',
    "Proxy-Authorization: Bearer opaque-token-123456",
    "retry used Bearer abc.def.ghi.123",
    "legacy used Basic dXNlcjpwYXNz",
    `jwt=${jwt}`
  ].join("\n"));

  assert.doesNotMatch(text, /dXNlcjpwYXNz|opaque-token|abc\.def|eyJhbGci/);
  assert.match(text, /"Authorization": "Basic \[REDACTED\]"/);
  assert.match(text, /Proxy-Authorization: Bearer \[REDACTED\]/);
  assert.match(text, /jwt=\[REDACTED\]/);
});

test("environment, JSON, URL, and signed-query credentials are redacted", () => {
  const text = redactSensitiveText([
    "OLLAMA_API_KEY=ollama-cloud-secret",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    '"client_secret": "two words and punctuation!"',
    "DATABASE_PASSWORD='correct horse battery staple'",
    "postgresql://database-user:database-pass@db.internal/app",
    "https://storage.example/object?X-Amz-Signature=deadbeef&X-Amz-Security-Token=session-value",
    "https://api.example/resource?access_token=query-token&view=compact"
  ].join("\n"));

  assert.doesNotMatch(text, /ollama-cloud-secret|aws-secret-value|two words|correct horse|database-user|database-pass|deadbeef|session-value|query-token/);
  assert.match(text, /OLLAMA_API_KEY=\[REDACTED\]/);
  assert.match(text, /"client_secret": "\[REDACTED\]"/);
  assert.match(text, /postgresql:\/\/\[REDACTED\]@db\.internal/);
  assert.match(text, /X-Amz-Signature=\[REDACTED\]/);
  assert.match(text, /access_token=\[REDACTED\]/);
});

test("private keys and common OpenAI, GitHub, AWS, and Google tokens are redacted", () => {
  const openAi = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const github = "github_pat_11AAabcdefghijklmnopqrstuvwxyz123456";
  const aws = "AKIAABCDEFGHIJKLMNOP";
  const googleApiKey = `AIza${"A".repeat(35)}`;
  const googleOauth = `ya29.${"b".repeat(24)}`;
  const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretmaterial\n-----END RSA PRIVATE KEY-----";
  const text = redactSensitiveText([openAi, github, aws, googleApiKey, googleOauth, privateKey].join("\n"));

  assert.doesNotMatch(text, /sk-proj|github_pat|AKIA|AIza|ya29|secretmaterial/);
  assert.match(text, /-----BEGIN RSA PRIVATE KEY-----\n\[REDACTED\]\n-----END RSA PRIVATE KEY-----/);
});

test("redaction leaves non-credential operational text intact", () => {
  const text = [
    "token_budget=5000 api_key_count=3 key=sort secretary=alice",
    "Basic authentication and Bearer authentication are supported. Bearer authentication.",
    "https://example.com/path?keyboard=compact&signatureVersion=4",
    "-----BEGIN PUBLIC KEY-----\npublic-material\n-----END PUBLIC KEY-----"
  ].join("\n");

  assert.equal(redactSensitiveText(text), text);
});

test("redaction is idempotent for persisted diagnostics", () => {
  const once = redactSensitiveText("Authorization: Bearer opaque-token-123456 api_key=secret-value");
  assert.equal(redactSensitiveText(once), once);
});
