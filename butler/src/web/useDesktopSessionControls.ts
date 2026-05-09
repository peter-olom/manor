import { useState } from "react";

import { postJson } from "./api";
import type { PreviewMedia, ToastTone } from "./types";

type DesktopActionArtifact = {
  kind?: string;
  label?: string;
  fileName?: string;
  contentType?: string;
  url?: string | null;
  downloadUrl?: string | null;
};

type DesktopActionResponse = {
  action?: {
    output?: unknown;
  };
};

function isDesktopActionArtifact(value: unknown): value is DesktopActionArtifact {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as DesktopActionArtifact).fileName === "string" &&
    typeof (value as DesktopActionArtifact).contentType === "string"
  );
}

function findScreenshotArtifact(value: unknown): DesktopActionArtifact | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (isDesktopActionArtifact(value) && value.kind === "screenshot" && value.url) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const artifact = findScreenshotArtifact(entry);
      if (artifact) {
        return artifact;
      }
    }
    return null;
  }
  for (const entry of Object.values(value)) {
    const artifact = findScreenshotArtifact(entry);
    if (artifact) {
      return artifact;
    }
  }
  return null;
}

export function useDesktopSessionControls(
  showToast: (message: string, tone?: ToastTone, duration?: number) => void,
  showErrorToast: (error: unknown) => void,
  onPreviewMedia: (media: PreviewMedia) => void
) {
  const [busyDesktopSessionId, setBusyDesktopSessionId] = useState<string | null>(null);

  async function captureDesktopScreen(sessionId: string) {
    setBusyDesktopSessionId(sessionId);
    try {
      const result = await postJson<DesktopActionResponse>("/api/desktop/sessions/action", {
        sessionId,
        actionType: "current_screen",
        label: "Operator desktop screenshot"
      });
      const screenshot = findScreenshotArtifact(result.action?.output);
      if (screenshot?.url) {
        onPreviewMedia({
          name: screenshot.label || screenshot.fileName || "Desktop screenshot",
          url: screenshot.url,
          kind: "image",
          downloadUrl: screenshot.downloadUrl ?? screenshot.url
        });
        showToast("Desktop screenshot ready");
      } else {
        showToast("Desktop screenshot captured");
      }
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyDesktopSessionId((current) => (current === sessionId ? null : current));
    }
  }

  async function stopDesktopSession(sessionId: string) {
    setBusyDesktopSessionId(sessionId);
    try {
      await postJson("/api/desktop/sessions/stop", { sessionId });
      showToast("Desktop session stopped");
    } catch (error) {
      showErrorToast(error);
    } finally {
      setBusyDesktopSessionId((current) => (current === sessionId ? null : current));
    }
  }

  return {
    busyDesktopSessionId,
    captureDesktopScreen,
    stopDesktopSession
  };
}
