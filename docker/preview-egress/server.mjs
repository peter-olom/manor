import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

const configPath = process.env.PREVIEW_EGRESS_PROFILES_FILE ?? "/opt/manor/config/preview-egress-profiles.json";
const adminPort = Number(process.env.PREVIEW_EGRESS_ADMIN_PORT ?? "8091");
const dynamicPortStart = Number(process.env.PREVIEW_EGRESS_DYNAMIC_PORT_START ?? "3200");
const dynamicPortEnd = Number(process.env.PREVIEW_EGRESS_DYNAMIC_PORT_END ?? "3299");

function loadStaticProfiles() {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed?.profiles) ? parsed.profiles : [];

  return entries.map((profile) => normalizeProfile(profile, "static"));
}

function normalizeDomain(domain) {
  return String(domain).trim().toLowerCase();
}

function normalizeDomains(domains) {
  const values = Array.isArray(domains) ? domains.map(normalizeDomain).filter(Boolean) : [];
  return [...new Set(values)];
}

function normalizeProfile(profile, source) {
  return {
    name: String(profile.name),
    port: Number(profile.port),
    domains: normalizeDomains(profile.domains),
    source
  };
}

function hostnameMatches(hostname, domain) {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  if (normalizedDomain.startsWith(".")) {
    const bare = normalizedDomain.slice(1);
    return normalizedHost === bare || normalizedHost.endsWith(normalizedDomain);
  }
  return normalizedHost === normalizedDomain;
}

function isAllowedHost(hostname, domains) {
  return domains.some((domain) => hostnameMatches(hostname, domain));
}

function isSafePort(port) {
  return port === 80 || port === 443;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function stripHopByHopHeaders(headers) {
  const nextHeaders = { ...headers };
  delete nextHeaders["proxy-authorization"];
  delete nextHeaders["proxy-authenticate"];
  delete nextHeaders["proxy-connection"];
  delete nextHeaders.connection;
  delete nextHeaders.upgrade;
  delete nextHeaders["keep-alive"];
  delete nextHeaders["transfer-encoding"];
  delete nextHeaders.te;
  delete nextHeaders.trailer;
  return nextHeaders;
}

function createProxyServer(profile) {
  const server = http.createServer((request, response) => {
    let targetUrl;

    try {
      if (/^https?:\/\//i.test(request.url ?? "")) {
        targetUrl = new URL(request.url);
      } else {
        const host = request.headers.host;
        if (!host) {
          writeJson(response, 400, { error: "Proxy request is missing a target host" });
          return;
        }
        targetUrl = new URL(`http://${host}${request.url ?? "/"}`);
      }
    } catch {
      writeJson(response, 400, { error: "Invalid proxy target URL" });
      return;
    }

    const hostname = targetUrl.hostname.toLowerCase();
    const port =
      targetUrl.port.length > 0 ? Number(targetUrl.port) : targetUrl.protocol === "https:" ? 443 : 80;

    if (!isSafePort(port)) {
      writeJson(response, 403, { error: `Port ${port} is not allowed for preview egress` });
      return;
    }

    if (!isAllowedHost(hostname, profile.domains)) {
      writeJson(response, 403, { error: `Host ${hostname} is not allowed for preview egress profile ${profile.name}` });
      return;
    }

    const transport = targetUrl.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname,
        port,
        method: request.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: stripHopByHopHeaders(request.headers)
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      }
    );

    upstream.on("error", (error) => {
      writeJson(response, 502, { error: error.message });
    });

    request.pipe(upstream);
  });

  server.on("connect", (request, clientSocket, head) => {
    const [hostnameRaw, portRaw] = String(request.url ?? "").split(":");
    const hostname = hostnameRaw?.toLowerCase() ?? "";
    const port = Number(portRaw ?? "443");

    if (!hostname || !Number.isFinite(port)) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    if (!isSafePort(port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    if (!isAllowedHost(hostname, profile.domains)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstreamSocket = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamSocket.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
  });

  return server;
}

const profileRegistry = new Map();
const staticProfiles = loadStaticProfiles();

function listProfiles() {
  return [...profileRegistry.values()].map(({ profile }) => profile);
}

function isPortInUse(port) {
  return [...profileRegistry.values()].some(({ profile }) => profile.port === port);
}

function allocateDynamicPort() {
  for (let port = dynamicPortStart; port <= dynamicPortEnd; port += 1) {
    if (!isPortInUse(port)) {
      return port;
    }
  }
  throw new Error("No preview egress ports are available for dynamic policies");
}

async function startProfile(profile) {
  if (!profile.name || !Number.isFinite(profile.port) || profile.port <= 0) {
    throw new Error(`Invalid preview egress profile entry: ${JSON.stringify(profile)}`);
  }

  const server = createProxyServer(profile);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(profile.port, "0.0.0.0", () => resolve());
  });

  profileRegistry.set(profile.name, { profile, server });
  console.log(`Preview egress profile ${profile.name} listening on ${profile.port}`);
  return profile;
}

async function stopProfile(name) {
  const entry = profileRegistry.get(name);
  if (!entry) {
    return false;
  }
  if (entry.profile.source === "static") {
    throw new Error(`Cannot remove static preview egress profile ${name}`);
  }

  await new Promise((resolve, reject) => {
    entry.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  profileRegistry.delete(name);
  return true;
}

for (const profile of staticProfiles) {
  await startProfile(profile);
}

const adminServer = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true, profiles: listProfiles() });
    return;
  }

  if (request.method === "GET" && request.url === "/profiles") {
    writeJson(response, 200, { profiles: listProfiles() });
    return;
  }

  if (request.method === "POST" && request.url === "/profiles") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const name = String(payload.name || "").trim();
        const domains = normalizeDomains(payload.domains);
        if (!name) {
          writeJson(response, 400, { error: "name is required" });
          return;
        }
        if (domains.length === 0) {
          writeJson(response, 400, { error: "domains must include at least one hostname" });
          return;
        }
        if (profileRegistry.has(name)) {
          writeJson(response, 409, { error: `Preview egress profile ${name} already exists` });
          return;
        }

        const profile = normalizeProfile(
          {
            name,
            port: allocateDynamicPort(),
            domains
          },
          "dynamic"
        );
        await startProfile(profile);
        writeJson(response, 201, profile);
      } catch (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return;
  }

  if (request.method === "DELETE" && request.url?.startsWith("/profiles/")) {
    const name = decodeURIComponent(request.url.slice("/profiles/".length));
    try {
      const removed = await stopProfile(name);
      if (!removed) {
        writeJson(response, 404, { error: `Preview egress profile ${name} was not found` });
        return;
      }
      writeJson(response, 200, { ok: true, name });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  writeJson(response, 404, { error: "Not found" });
});

adminServer.listen(adminPort, "0.0.0.0", () => {
  console.log(`Preview egress admin listening on ${adminPort}`);
});
