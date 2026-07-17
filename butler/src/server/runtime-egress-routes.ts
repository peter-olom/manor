import { lookup } from "node:dns/promises";

import type { Express, Request, Response } from "express";

import type { RuntimeEgressClient } from "./runtime-egress-client.js";

type RuntimeEgressRouteAccess = {
  app: Express;
  client: RuntimeEgressClient;
  operatorGatewayHost: string;
};

const LOCAL_OPERATOR_HEADER = "x-manor-local-operator";

function normalizeAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/, "");
}

async function isLocalOperatorRequest(request: Request, gatewayHost: string): Promise<boolean> {
  if (request.header(LOCAL_OPERATOR_HEADER) !== "1") return false;
  const remoteAddress = normalizeAddress(request.socket.remoteAddress);
  try {
    const gatewayAddresses = await lookup(gatewayHost, { all: true });
    return gatewayAddresses.some((entry) => normalizeAddress(entry.address) === remoteAddress);
  } catch {
    return false;
  }
}

function sendError(response: Response, error: unknown): void {
  response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

export function registerRuntimeEgressRoutes(access: RuntimeEgressRouteAccess): void {
  access.app.use("/api/runtime-egress", async (request, response, next) => {
    if (!await isLocalOperatorRequest(request, access.operatorGatewayHost)) {
      response.status(401).json({ error: "Runtime egress changes require the local operator UI." });
      return;
    }
    next();
  });

  access.app.get("/api/runtime-egress/domains", async (_request, response) => {
    try {
      response.json(await access.client.list());
    } catch (error) {
      sendError(response, error);
    }
  });

  access.app.post("/api/runtime-egress/domains", async (request, response) => {
    try {
      const domain = typeof request.body?.domain === "string" ? request.body.domain.trim() : "";
      if (!domain) throw new Error("Enter a hostname to allow.");
      response.status(201).json(await access.client.add(domain));
    } catch (error) {
      sendError(response, error);
    }
  });

  access.app.delete("/api/runtime-egress/domains/:domain", async (request, response) => {
    try {
      response.json(await access.client.remove(request.params.domain));
    } catch (error) {
      sendError(response, error);
    }
  });
}
