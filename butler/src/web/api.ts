export type FileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
};

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
