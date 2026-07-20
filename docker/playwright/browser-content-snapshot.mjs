import { createHash } from "node:crypto";

export async function refreshContentSnapshot(session) {
  const visibleContent = await session.page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 24000)).catch(() => "");
  session.visibleContent = visibleContent;
  session.contentDigest = createHash("sha256").update(visibleContent).digest("hex");
}

export function browserSessionSummary(session) {
  return {
    sessionId: session.sessionId, runId: session.runId, mode: session.mode,
    targetUrl: session.targetUrl, outputDir: session.outputDir,
    startedAt: session.startedAt, lastActivityAt: session.lastActivityAt,
    status: session.status, title: session.title, url: session.url,
    resolution: session.resolution, viewport: session.viewport,
    actionCount: session.actions.length, visibleContent: session.visibleContent || "", contentDigest: session.contentDigest || "",
    previewAnnotationLayer: Boolean(session.previewAnnotationLayer), annotationLayerInstalled: Boolean(session.annotationLayerInstalled),
    annotationBatchCount: session.annotationBatches.length,
    annotations: { targets: session.annotationTargets, batches: session.annotationBatches, insertions: session.annotationInsertions },
    auth: {
      headerCount: Object.keys(session.headers).length,
      cookieCount: session.cookies.length,
      cookieNames: session.cookies.map((entry) => entry.name),
      usedSessionCookie: session.cookies.some((entry) => entry.name === "better-auth.session_token")
    }
  };
}
