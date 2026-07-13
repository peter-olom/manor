import type { ReferenceLibraryItem, ReferenceLibraryResponse, ReferenceMetadata, ReferenceOrigin } from "../shared/references";

export type FileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
  metadata?: ReferenceMetadata;
};

export type ReferenceUploadContext = {
  sessionId?: string;
  origin: ReferenceOrigin;
};

export type StoredReference = ReferenceLibraryItem;
export type TextPreviewResponse = { text: string; truncated: boolean };

const VISION_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VISION_IMAGE_EXTENSION_MIME_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"]
]);

export function resolveVisionImageMimeType(mimeType: string, name = ""): string | null {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (VISION_IMAGE_MIME_TYPES.has(normalizedMimeType)) return normalizedMimeType;
  if (normalizedMimeType && normalizedMimeType !== "application/octet-stream") return null;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return VISION_IMAGE_EXTENSION_MIME_TYPES.get(extension) ?? null;
}

export function isVisionImageFile(mimeType: string, name = ""): boolean {
  return resolveVisionImageMimeType(mimeType, name) !== null;
}

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

export async function patchJson<T = void>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
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

function uploadContextHeaders(context?: ReferenceUploadContext): Record<string, string> {
  if (!context) return {};
  return {
    "X-Manor-Reference-Origin": context.origin,
    ...(context.sessionId ? { "X-Manor-Session-Id": encodeURIComponent(context.sessionId) } : {})
  };
}

export async function uploadAttachment(file: File, context?: ReferenceUploadContext): Promise<FileReference> {
  const imageMimeType = resolveVisionImageMimeType(file.type, file.name);
  const uploadMimeType = (imageMimeType ?? file.type) || "application/octet-stream";
  const response = await fetch(imageMimeType ? "/api/images/upload" : "/api/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": uploadMimeType,
      "X-Manor-Upload-Name": encodeURIComponent(file.name),
      "X-Manor-Upload-Size": String(file.size),
      "X-Manor-Upload-Mime-Type": uploadMimeType,
      ...uploadContextHeaders(context)
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

export async function uploadFileVersion(file: File, sourceReferenceId: string, context?: ReferenceUploadContext): Promise<FileReference> {
  const response = await fetch("/api/files/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Manor-Upload-Name": encodeURIComponent(file.name),
      "X-Manor-Upload-Size": String(file.size),
      "X-Manor-Upload-Mime-Type": file.type || "application/octet-stream",
      "X-Manor-Source-Reference-Id": sourceReferenceId,
      ...uploadContextHeaders(context)
    },
    body: file
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  const payload = (await response.json().catch(() => undefined)) as { file?: FileReference } | undefined;
  if (!payload?.file) throw new Error("Version upload failed");
  return payload.file;
}

export async function listStoredReferences(): Promise<StoredReference[]> {
  const payload = await getJson<ReferenceLibraryResponse>("/api/references");
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function getStoredTextPreview(previewUrl: string, signal?: AbortSignal): Promise<TextPreviewResponse> {
  return getJson<TextPreviewResponse>(previewUrl, { signal });
}

export async function deleteStoredReference(id: string): Promise<void> {
  const response = await fetch(`/api/references/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}
