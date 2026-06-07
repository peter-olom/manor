import type express from "express";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerPreviewAnnotationRoutes(app: express.Express) {
  app.post("/api/preview-annotations/batches", (request, response) => {
    if (!isJsonObject(request.body)) {
      response.status(400).json({ error: "Annotation batch body must be a JSON object" });
      return;
    }

    response.status(202).json({ ok: true });
  });
}
