import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_STATE_PATH = "/state/operator-domains.json";
const DEFAULT_ACL_PATH = "/state/operator-domains.txt";
const DEFAULT_BUILT_INS_PATH = "/etc/squid/built-in-domains.txt";
const DEFAULT_SQUID_CONFIG_PATH = "/etc/squid/squid.conf";
const MAX_BODY_BYTES = 16 * 1024;
const RESERVED_HOSTS = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
  "docker.internal"
]);

export function normalizeDomain(value) {
  if (typeof value !== "string") {
    throw new Error("domain must be a hostname string");
  }

  const domain = value.trim().toLowerCase();
  const includeSubdomains = domain.startsWith(".");
  const hostname = includeSubdomains ? domain.slice(1) : domain;

  if (!hostname || hostname.startsWith(".") || hostname.endsWith(".")) {
    throw new Error("domain must be a valid hostname");
  }
  if (domain.includes("://") || /[\s/@:*?#\\]/.test(domain)) {
    throw new Error("domain must contain only a hostname");
  }
  if (net.isIP(hostname) !== 0) {
    throw new Error("IP addresses are not allowed");
  }
  if (!hostname.includes(".")) {
    throw new Error("single-label and internal hostnames are not allowed");
  }
  if (RESERVED_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".docker.internal")) {
    throw new Error("localhost and internal hostnames are not allowed");
  }
  if (hostname.length > 253) {
    throw new Error("domain is too long");
  }

  const labels = hostname.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("domain must be a valid hostname");
  }

  return includeSubdomains ? `.${hostname}` : hostname;
}

function readDomainFile(path, { validate = true } = {}) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const domains = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return [...new Set(validate ? domains.map(normalizeDomain) : domains.map((domain) => domain.toLowerCase()))];
}

function atomicWrite(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, path);
}

function readOperatorState(statePath) {
  if (!fs.existsSync(statePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.domains)) {
    throw new Error("Invalid persisted runtime egress state");
  }
  return [...new Set(parsed.domains.map(normalizeDomain))].sort();
}

function writeOperatorFiles(statePath, aclPath, domains) {
  atomicWrite(statePath, `${JSON.stringify({ version: 1, domains }, null, 2)}\n`);
  atomicWrite(aclPath, domains.length > 0 ? `${domains.join("\n")}\n` : "");
}

export function createEgressPolicy(options = {}) {
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const aclPath = options.aclPath ?? DEFAULT_ACL_PATH;
  const builtInsPath = options.builtInsPath ?? DEFAULT_BUILT_INS_PATH;
  const reload = options.reload ?? (async () => {
    await execFileAsync("squid", ["-k", "reconfigure", "-f", DEFAULT_SQUID_CONFIG_PATH]);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  const builtIns = readDomainFile(builtInsPath, { validate: false }).sort();
  const builtInSet = new Set(builtIns);
  let operatorDomains = readOperatorState(statePath);
  let mutation = Promise.resolve();

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeOperatorFiles(statePath, aclPath, operatorDomains);

  function list() {
    return [
      ...builtIns.map((domain) => ({ domain, source: "built-in", removable: false })),
      ...operatorDomains.map((domain) => ({ domain, source: "operator", removable: true }))
    ];
  }

  function enqueue(action) {
    const result = mutation.then(action, action);
    mutation = result.catch(() => {});
    return result;
  }

  async function replaceOperatorDomains(nextDomains) {
    const previousDomains = operatorDomains;
    writeOperatorFiles(statePath, aclPath, nextDomains);
    try {
      await reload();
      operatorDomains = nextDomains;
    } catch (error) {
      writeOperatorFiles(statePath, aclPath, previousDomains);
      try {
        await reload();
      } catch {
        // Keep the original reload error; the persisted files still describe the previous policy.
      }
      throw error;
    }
  }

  function add(value) {
    return enqueue(async () => {
      const domain = normalizeDomain(value);
      if (builtInSet.has(domain)) {
        return { created: false, domains: list() };
      }
      if (operatorDomains.includes(domain)) {
        return { created: false, domains: list() };
      }
      await replaceOperatorDomains([...operatorDomains, domain].sort());
      return { created: true, domains: list() };
    });
  }

  function remove(value) {
    return enqueue(async () => {
      const domain = normalizeDomain(value);
      if (builtInSet.has(domain)) {
        const error = new Error("Built-in runtime egress domains cannot be removed");
        error.code = "BUILT_IN";
        throw error;
      }
      if (!operatorDomains.includes(domain)) {
        const error = new Error(`Runtime egress domain ${domain} was not found`);
        error.code = "NOT_FOUND";
        throw error;
      }
      await replaceOperatorDomains(operatorDomains.filter((entry) => entry !== domain));
      return { domains: list() };
    });
  }

  return { add, list, remove };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function isAuthorized(request, token) {
  return Boolean(token) && request.headers.authorization === `Bearer ${token}`;
}

export function createAdminServer({ policy, token }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://egress");
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (!isAuthorized(request, token)) {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/domains") {
        writeJson(response, 200, { domains: policy.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/domains") {
        const payload = await readJson(request);
        const result = await policy.add(payload?.domain);
        writeJson(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/domains/")) {
        const domain = decodeURIComponent(url.pathname.slice("/domains/".length));
        writeJson(response, 200, await policy.remove(domain));
        return;
      }
      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error?.code === "BUILT_IN" ? 409 : error?.code === "NOT_FOUND" ? 404 : 400;
      writeJson(response, statusCode, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const policy = createEgressPolicy();
  if (!process.argv.includes("--init")) {
    const token = process.env.EGRESS_ADMIN_TOKEN;
    if (!token) {
      throw new Error("EGRESS_ADMIN_TOKEN is required");
    }
    const port = Number(process.env.EGRESS_ADMIN_PORT ?? "8092");
    createAdminServer({ policy, token }).listen(port, "0.0.0.0", () => {
      console.log(`Runtime egress admin listening on ${port}`);
    });
  }
}
