import type http from "node:http";

export function isBinaryUploadRequest(request: http.IncomingMessage): boolean {
  return typeof request.headers["x-manor-upload-name"] === "string";
}

export function shouldParseJsonRequest(request: http.IncomingMessage): boolean {
  if (isBinaryUploadRequest(request)) return false;
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return contentType === "application/json" || (contentType.startsWith("application/") && contentType.endsWith("+json"));
}
