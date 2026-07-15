import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.trim().length === 0) {
  throw new Error("butler/package.json must contain a non-empty Manor version");
}

export const MANOR_VERSION = packageMetadata.version;
