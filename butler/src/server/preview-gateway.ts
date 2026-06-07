import crypto from "node:crypto";
import http from "node:http";

import type express from "express";
import type httpProxy from "http-proxy";

import { PREVIEW_ANNOTATION_LAYER_SCRIPT } from "./preview-annotation-layer.js";
import { resolvePreviewProxyTarget, type RuntimeServerAccess } from "./server-runtime-helpers.js";

export type PreviewRouteUrl = {
  leaseId: string;
  brokerUrl: string;
};

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function normalizeProxyPath(rawUrl: string | undefined) {
  const url = rawUrl || "/";
  return url.startsWith("/") ? url : `/${url}`;
}

export function resolvePreviewRouteUrl(rawUrl: string | undefined): PreviewRouteUrl | null {
  const url = rawUrl || "";
  const originalPath = url.split("?")[0] ?? url;
  const match = originalPath.match(/^\/preview\/([^/]+)(\/.*)?$/);
  const leaseId = match?.[1] || "";
  if (!leaseId) {
    return null;
  }

  const suffix = match?.[2] ?? "/";
  const search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  return {
    leaseId,
    brokerUrl: `/routes/preview/${leaseId}${suffix}${search}`
  };
}

function resolveBrokerPreviewRouteUrl(rawUrl: string | undefined): PreviewRouteUrl | null {
  const url = rawUrl || "";
  const originalPath = url.split("?")[0] ?? url;
  const match = originalPath.match(/^\/routes\/preview\/([^/]+)(\/.*)?$/);
  const leaseId = match?.[1] || "";
  if (!leaseId) {
    return null;
  }

  return {
    leaseId,
    brokerUrl: url
  };
}

export function resolvePreviewRefererRouteUrl(
  rawUrl: string | undefined,
  refererHeader: string | string[] | undefined
): PreviewRouteUrl | null {
  if (resolvePreviewRouteUrl(rawUrl)) {
    return null;
  }

  const referer = firstHeaderValue(refererHeader);
  if (!referer) {
    return null;
  }

  let parsedReferer: URL;
  try {
    parsedReferer = new URL(referer, "http://localhost");
  } catch {
    return null;
  }

  const previewRoute = resolvePreviewRouteUrl(`${parsedReferer.pathname}${parsedReferer.search}`);
  if (!previewRoute) {
    return null;
  }

  return {
    leaseId: previewRoute.leaseId,
    brokerUrl: `/routes/preview/${previewRoute.leaseId}${normalizeProxyPath(rawUrl)}`
  };
}

export function proxyPreviewRoute(
  access: RuntimeServerAccess,
  previewProxy: httpProxy,
  previewRoute: PreviewRouteUrl,
  request: express.Request,
  response: express.Response
) {
  const target = resolvePreviewProxyTarget(access, previewRoute.leaseId);
  if (!target) {
    response.status(404).json({ error: "Preview lease not found" });
    return;
  }

  request.url = previewRoute.brokerUrl;
  previewProxy.web(request, response, { target }, (error: Error) => {
    response.status(502).json({ error: error instanceof Error ? error.message : "Preview proxy failed" });
  });
}

function previewRoutePrefix(leaseId: string) {
  return `/preview/${leaseId}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldRewritePreviewResponse(contentType: string) {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/html") ||
    normalized.includes("text/css") ||
    normalized.includes("javascript") ||
    normalized.includes("ecmascript")
  );
}

function buildPreviewAnnotationTargets(access: RuntimeServerAccess, leaseId: string) {
  const targets = [{ id: "butler", label: "Butler" }];
  const lease = access.store.getPreviewLease(leaseId);
  if (lease?.threadId) {
    targets.push({ id: `thread:${lease.threadId}`, label: "Codex job" });
  }
  return targets;
}

function escapeInlineScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildPreviewAnnotationToken(access: RuntimeServerAccess, leaseId: string) {
  return crypto.createHmac("sha256", access.previewAnnotationSecret).update(leaseId).digest("hex");
}

function buildPreviewAnnotationInjection(access: RuntimeServerAccess, leaseId: string) {
  const targets = buildPreviewAnnotationTargets(access, leaseId);
  const token = buildPreviewAnnotationToken(access, leaseId);
  const script = `(() => {
` +
    `const annotationConfig = {
` +
    `  leaseId: ${escapeInlineScriptJson(leaseId)},
` +
    `  targets: ${escapeInlineScriptJson(targets)},
` +
    `  commit: async (payload) => {
` +
    `    const response = await fetch("/api/preview-annotations/batches", {
` +
    `      method: "POST",
` +
    `      headers: { "content-type": "application/json", "x-manor-preview-annotation-token": ${escapeInlineScriptJson(token)} },
` +
    `      body: JSON.stringify({ ...payload, leaseId: ${escapeInlineScriptJson(leaseId)} })
` +
    `    });
` +
    `    const result = await response.json().catch(() => ({}));
` +
    `    if (!response.ok) throw new Error(result.error || "Annotation capture failed");
` +
    `    return result;
` +
    `  }
` +
    `};
` +
    `try {
` +
    `  window.__manorPreviewAnnotationConfig = annotationConfig;
` +
    `${PREVIEW_ANNOTATION_LAYER_SCRIPT}
` +
    `} finally {
` +
    `  delete window.__manorPreviewAnnotationConfig;
` +
    `  document.currentScript?.remove();
` +
    `}
` +
    `})();`;
  return `<script data-manor-preview-annotations>${script.replace(/<\/script/gi, "<\\/script")}</script>`;
}

function injectPreviewAnnotations(body: string, access: RuntimeServerAccess, leaseId: string) {
  if (body.includes("data-manor-preview-annotations") || body.includes("manor-preview-annotation-layer")) {
    return body;
  }
  const injection = buildPreviewAnnotationInjection(access, leaseId);
  if (/<\/body>/i.test(body)) {
    return body.replace(/<\/body>/i, `${injection}</body>`);
  }
  return `${body}${injection}`;
}

function rewritePreviewResponseBody(body: string, leaseId: string, options?: { access?: RuntimeServerAccess; injectAnnotations?: boolean }) {
  const prefix = previewRoutePrefix(leaseId);
  const escapedPrefix = escapeRegExp(prefix);
  const rewritten = body
    .replace(/((?:src|href|action|poster)=["'])\/(?!\/|preview\/)/gi, `$1${prefix}/`)
    .replace(/(\bfrom\s*["'])\/(?!\/|preview\/)/g, `$1${prefix}/`)
    .replace(/(\bimport\s*["'])\/(?!\/|preview\/)/g, `$1${prefix}/`)
    .replace(/(\bimport\s*\(\s*["'])\/(?!\/|preview\/)/g, `$1${prefix}/`)
    .replace(/(\bnew URL\(\s*["'])\/(?!\/|preview\/)/g, `$1${prefix}/`)
    .replace(new RegExp(`${escapedPrefix}/@vite/client(?!\\?)`, "g"), `${prefix}/@vite/client?manor_preview=${leaseId}`)
    .replace(
      /new WebSocket\(`\$\{socketProtocol\}:\/\/\$\{socketHost\}\?/g,
      `new WebSocket(\`\${socketProtocol}://\${socketHost.replace(/\\/$/, "")}${prefix}/?`
    )
    .replace(/(url\(\s*["']?)\/(?!\/|preview\/)/gi, `$1${prefix}/`);
  return options?.injectAnnotations && options.access ? injectPreviewAnnotations(rewritten, options.access, leaseId) : rewritten;
}

export function registerPreviewProxyResponseRewriter(previewProxy: httpProxy, access: RuntimeServerAccess) {
  previewProxy.on("proxyRes", (proxyResponse, request, response) => {
    const serverResponse = response as http.ServerResponse;
    const previewRoute = resolveBrokerPreviewRouteUrl(request.url);
    const contentTypeHeader = proxyResponse.headers["content-type"];
    const contentType = firstHeaderValue(contentTypeHeader);

    if (!previewRoute || !shouldRewritePreviewResponse(contentType)) {
      serverResponse.writeHead(proxyResponse.statusCode ?? 500, proxyResponse.headers);
      proxyResponse.pipe(serverResponse);
      return;
    }

    const chunks: Buffer[] = [];
    proxyResponse.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proxyResponse.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const rewrittenBody = rewritePreviewResponseBody(body, previewRoute.leaseId, {
        access,
        injectAnnotations: contentType.toLowerCase().includes("text/html")
      });
      const headers = { ...proxyResponse.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      serverResponse.writeHead(proxyResponse.statusCode ?? 500, headers);
      serverResponse.end(rewrittenBody);
    });
    proxyResponse.on("error", () => {
      serverResponse.destroy();
    });
  });
}
