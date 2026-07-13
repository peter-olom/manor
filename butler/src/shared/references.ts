export type ReferenceLibraryKind = "image" | "file";
export type ReferencePreviewKind = "text" | "markdown" | "html" | "pdf";
export type ReferenceOrigin =
  | "butler-upload"
  | "file-explorer"
  | "image-annotation"
  | "pdf-annotation"
  | "worker-output"
  | "preview-annotation";

export type ReferenceMetadata = {
  projectId?: string;
  projectLabel?: string;
  sessionId?: string;
  sessionTitle?: string;
  origin?: ReferenceOrigin;
};

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkdn"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "log", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "conf", "env",
  "css", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "zsh",
  "sql", "php", "swift", "kt", "kts", "scala", "lua", "r", "dart", "ex", "exs", "erl", "hrl", "fs", "fsx", "cs",
  "vue", "svelte", "properties", "cfg", "gitignore", "dockerignore", "editorconfig"
]);
const TEXT_FILE_NAMES = new Set(["readme", "license", "dockerfile", "makefile", "procfile", "gemfile", "rakefile"]);

export function resolveReferencePreviewKind(name: string, mimeType: string): ReferencePreviewKind | null {
  const normalizedMimeType = mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  const normalizedName = name.trim().toLowerCase();
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf" || normalizedMimeType === "application/pdf") return "pdf";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (TEXT_EXTENSIONS.has(extension) || TEXT_FILE_NAMES.has(normalizedName)) return "text";
  if (normalizedMimeType === "text/markdown") return "markdown";
  if (normalizedMimeType === "text/html") return "html";
  if (
    normalizedMimeType.startsWith("text/") ||
    /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/.test(normalizedMimeType) ||
    ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/ecmascript", "application/sql"].includes(normalizedMimeType)
  ) return "text";
  return null;
}

export type ReferenceLibraryItem = {
  id: string;
  kind: ReferenceLibraryKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  url: string;
  downloadUrl: string;
  previewUrl?: string;
  previewKind?: ReferencePreviewKind;
  sourceReferenceId?: string;
  metadata?: ReferenceMetadata;
  version: number;
  hasChildren: boolean;
};

export type ReferenceLibraryResponse = {
  items: ReferenceLibraryItem[];
};
