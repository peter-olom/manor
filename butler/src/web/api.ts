import type { FileReference } from "./types";

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => ({ error: "" }));
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  }

  const text = await response.text().catch(() => "");
  if (response.status === 413) {
    return "Upload exceeded the configured limit";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || `Request failed with ${response.status}`;
}

export async function postJson<T = void>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json().catch(() => undefined)) as T;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json().catch(() => undefined)) as T;
}

export async function uploadAttachment(file: File): Promise<FileReference> {
  const response = await fetch(file.type.startsWith("image/") ? "/api/images/upload" : "/api/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Manor-Upload-Name": encodeURIComponent(file.name),
      "X-Manor-Upload-Size": String(file.size),
      "X-Manor-Upload-Mime-Type": file.type || "application/octet-stream"
    },
    body: file
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json().catch(() => undefined)) as
    | { ok: true; image?: FileReference; file?: FileReference }
    | undefined;
  const uploaded = payload?.image ?? payload?.file;
  if (!uploaded) {
    throw new Error("Upload failed");
  }
  return uploaded;
}

function inferDownloadFileName(href: string, contentDisposition: string | null): string {
  if (contentDisposition) {
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      return decodeURIComponent(utf8Match[1]);
    }

    const plainMatch = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
    if (plainMatch?.[1]) {
      return plainMatch[1];
    }
  }

  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const parsed = href.startsWith("/") ? new URL(href, baseOrigin) : new URL(href);
    const fileName = parsed.pathname.split("/").filter(Boolean).at(-1);
    return fileName || "download";
  } catch {
    return "download";
  }
}

export async function readResourceError(response: Response): Promise<string> {
  const headerMessage = response.headers.get("x-artifact-error");
  if (headerMessage) {
    return headerMessage;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as { error?: string };
      if (typeof payload.error === "string" && payload.error.trim()) {
        return payload.error.trim();
      }
    } catch {
      // ignore parse failures
    }
  }

  return `Request failed with ${response.status}`;
}

export async function probeResourceAvailability(href: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    const response = await fetch(href, { method: "HEAD" });
    if (response.ok) {
      return { ok: true, message: null };
    }
    return { ok: false, message: await readResourceError(response) };
  } catch {
    return { ok: false, message: "The proof file could not be opened." };
  }
}

export async function triggerResourceDownload(href: string): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(await readResourceError(response));
  }

  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = inferDownloadFileName(href, response.headers.get("content-disposition"));
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}
