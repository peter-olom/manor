import type { Express, Request, Response } from "express";

import { SkillsService, type SkillEnvironmentId, type SkillScope } from "./skills-service.js";

function environment(request: Request): SkillEnvironmentId {
  const value = typeof request.params.environment === "string"
    ? request.params.environment
    : typeof request.body?.environment === "string"
      ? request.body.environment
      : "";
  if (value !== "butler-pi" && value !== "worker-pi" && value !== "worker-codex") {
    throw new Error("Unknown skill environment.");
  }
  return value;
}

function scope(value: unknown): SkillScope {
  if (value === undefined || value === null || value === "user") return "user";
  if (value === "project") return "project";
  throw new Error("Skill scope must be user or project.");
}

function cwd(request: Request): string | null {
  const value = request.method === "GET" ? request.query.cwd : request.body?.cwd;
  return typeof value === "string" && value.trim() ? value : null;
}

function id(request: Request): string {
  const value = typeof request.params.id === "string" ? request.params.id : "";
  if (!value) throw new Error("Skill id is required.");
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusFor(error: unknown): number {
  const value = message(error).toLowerCase();
  if (value.includes("not found")) return 404;
  if (value.includes("already exists")) return 409;
  if (value.includes("read-only") || value.includes("does not support")) return 403;
  return 400;
}

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(statusFor(error)).json({ error: message(error) });
    }
  };
}

export function registerSkillsRoutes(app: Express, service: SkillsService, options: { onMutation?: (environment: SkillEnvironmentId) => void } = {}): void {
  const mutated = (environmentId: SkillEnvironmentId) => options.onMutation?.(environmentId);
  app.get("/api/skills/environments", (_request, response) => {
    response.json({ environments: service.listEnvironments() });
  });

  app.get("/api/skills/:environment", route(async (request, response) => {
    response.json({ skills: await service.list(environment(request), cwd(request)) });
  }));

  app.get("/api/skills/:environment/:id", route(async (request, response) => {
    response.json({ skill: await service.read(environment(request), id(request), cwd(request)) });
  }));

  app.post("/api/skills", route(async (request, response) => {
    const environmentId = environment(request);
    const skill = await service.create({
      environment: environmentId,
      name: request.body?.name,
      description: request.body?.description,
      instructions: typeof request.body?.instructions === "string" ? request.body.instructions : "",
      scope: scope(request.body?.scope),
      cwd: cwd(request)
    });
    mutated(environmentId);
    response.status(201).json({ skill });
  }));

  app.put("/api/skills/:environment/:id", route(async (request, response) => {
    if (typeof request.body?.content !== "string") throw new Error("Skill content is required.");
    const environmentId = environment(request);
    const skill = await service.edit({
      environment: environmentId,
      id: id(request),
      content: request.body.content,
      cwd: cwd(request)
    });
    mutated(environmentId);
    response.json({ skill });
  }));

  app.delete("/api/skills/:environment/:id", route(async (request, response) => {
    const environmentId = environment(request);
    await service.delete(environmentId, id(request), cwd(request));
    mutated(environmentId);
    response.status(204).end();
  }));

  app.post("/api/skills/import", route(async (request, response) => {
    if (typeof request.body?.archiveBase64 !== "string") throw new Error("Skill archive is required.");
    const environmentId = environment(request);
    const skills = await service.importArchive({
      environment: environmentId,
      archiveBase64: request.body.archiveBase64,
      scope: scope(request.body?.scope),
      cwd: cwd(request)
    });
    mutated(environmentId);
    response.status(201).json({ skills });
  }));
}
