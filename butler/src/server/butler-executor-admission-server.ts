import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

type HarnessResult = { text: string; data?: Record<string, unknown> };

export function createButlerExecutorAdmissionServer(options: {
  handleAction: (input: { token: string; action: string; params: Record<string, unknown> }) => Promise<HarnessResult>;
}): http.Server {
  return http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/harness/action") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) request.destroy(new Error("Admission request is too large."));
      else chunks.push(value);
    });
    request.on("error", () => {
      if (!response.headersSent) response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "Admission request is too large." }));
    });
    request.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const token = typeof body.token === "string" ? body.token : "";
          const action = typeof body.action === "string" ? body.action : "";
          const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
            ? body.params as Record<string, unknown>
            : {};
          if (!token || action !== "content.admit") throw new Error("Only content admission is available on this socket.");
          const result = await options.handleAction({ token, action, params });
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      })();
    });
  });
}

export async function listenOnButlerExecutorAdmissionSocket(server: http.Server, socketPath: string): Promise<void> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o666);
}

export async function startButlerExecutorAdmissionServer(socketPath: string, handleAction: (input: { token: string; action: string; params: Record<string, unknown> }) => Promise<HarnessResult>): Promise<http.Server> {
  const server = createButlerExecutorAdmissionServer({ handleAction });
  await listenOnButlerExecutorAdmissionSocket(server, socketPath);
  return server;
}
