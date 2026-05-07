import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import JSZip from "jszip";
import { PDFParse } from "pdf-parse";

import type { PreviewVerificationArtifactView } from "./types.js";

const MAX_TEXT_CHARS = 12000;
const MAX_TOTAL_TEXT_CHARS = 36000;
const MAX_ARCHIVE_TEXT_FILES = 4;
const MAX_ARCHIVE_LIST_ENTRIES = 80;

export type InspectedProofArtifacts = {
  artifactSummary: string;
  textEvidence: string;
  imageArtifacts: PreviewVerificationArtifactView[];
};

function extension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

function truncate(value: string, limit = MAX_TEXT_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]` : value;
}

function cleanText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function xmlToText(value: string): string {
  return cleanText(
    decodeXmlEntities(
      value
        .replace(/<[^>]*(?:br|p|tab|tr|row|si|slide)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]{2,}/g, " ")
    )
  );
}

function isImageArtifact(artifact: PreviewVerificationArtifactView): boolean {
  return artifact.kind === "screenshot" || artifact.contentType.startsWith("image/");
}

function isTextLike(artifact: PreviewVerificationArtifactView): boolean {
  const ext = extension(artifact.fileName);
  return (
    artifact.kind === "html" ||
    artifact.contentType.startsWith("text/") ||
    artifact.contentType.includes("json") ||
    artifact.contentType.includes("xml") ||
    artifact.contentType.includes("csv") ||
    [".csv", ".html", ".htm", ".json", ".log", ".md", ".txt", ".xml", ".yaml", ".yml"].includes(ext)
  );
}

function isPdf(artifact: PreviewVerificationArtifactView): boolean {
  return artifact.contentType === "application/pdf" || extension(artifact.fileName) === ".pdf";
}

function isZipLike(artifact: PreviewVerificationArtifactView): boolean {
  const ext = extension(artifact.fileName);
  return [".docx", ".jar", ".odp", ".ods", ".odt", ".pptx", ".war", ".xlsx", ".zip"].includes(ext) || artifact.contentType.includes("zip");
}

function isTarLike(artifact: PreviewVerificationArtifactView): boolean {
  return /\.(tar|tgz|tar\.gz)$/i.test(artifact.fileName);
}

function artifactLine(artifact: PreviewVerificationArtifactView, buffer: Buffer | null): string {
  const size = artifact.sizeBytes ?? buffer?.byteLength ?? null;
  const hash = buffer ? crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16) : "unread";
  return `${artifact.kind} | ${artifact.label} | ${artifact.fileName} | ${artifact.contentType} | ${size ?? "unknown"} bytes | sha256=${hash}`;
}

async function inspectPdf(buffer: Buffer, artifact: PreviewVerificationArtifactView): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const text = await parser.getText().catch(() => null);
    const info = await parser.getInfo().catch(() => null);
    const meta = info ? `pages=${info.total}${info.info?.Title ? ` title=${info.info.Title}` : ""}${info.info?.Author ? ` author=${info.info.Author}` : ""}` : "metadata unavailable";
    return [`PDF ${artifact.fileName}: ${meta}`, text?.text ? truncate(cleanText(text.text)) : "No extractable PDF text found."].join("\n");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function zipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  return file ? file.async("string") : "";
}

async function inspectOfficeZip(zip: JSZip, artifact: PreviewVerificationArtifactView): Promise<string | null> {
  const ext = extension(artifact.fileName);
  if (ext === ".docx") {
    const names = Object.keys(zip.files).filter((name) => /^word\/(document|header\d*|footer\d*|comments)\.xml$/i.test(name));
    const text = xmlToText((await Promise.all(names.map((name) => zipText(zip, name)))).join("\n"));
    return `Office document ${artifact.fileName}:\n${truncate(text || "No document text found.")}`;
  }
  if (ext === ".pptx") {
    const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort();
    const sections = await Promise.all(names.slice(0, 12).map(async (name, index) => `Slide ${index + 1}: ${xmlToText(await zipText(zip, name))}`));
    return `Office presentation ${artifact.fileName}:\n${truncate(sections.join("\n\n") || "No slide text found.")}`;
  }
  if (ext === ".xlsx") {
    const shared = xmlToText(await zipText(zip, "xl/sharedStrings.xml")).split(/\s{2,}|\n+/).filter(Boolean);
    const sheets = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort();
    const sections = await Promise.all(sheets.slice(0, 8).map(async (name, index) => `Sheet ${index + 1}: ${extractSheetText(await zipText(zip, name), shared)}`));
    return `Office spreadsheet ${artifact.fileName}:\n${truncate(sections.join("\n\n") || "No sheet text found.")}`;
  }
  if ([".odt", ".ods", ".odp"].includes(ext)) {
    return `OpenDocument ${artifact.fileName}:\n${truncate(xmlToText(await zipText(zip, "content.xml")) || "No document text found.")}`;
  }
  return null;
}

function extractSheetText(xml: string, sharedStrings: string[]): string {
  const values: string[] = [];
  for (const match of xml.matchAll(/<c\b([^>]*)>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)) {
    const attrs = match[1] ?? "";
    const raw = decodeXmlEntities(match[2] ?? "").trim();
    values.push(/\bt="s"/.test(attrs) ? sharedStrings[Number(raw)] ?? raw : raw);
    if (values.length >= 200) break;
  }
  for (const match of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) {
    values.push(decodeXmlEntities(match[1] ?? "").trim());
    if (values.length >= 240) break;
  }
  return cleanText(values.filter(Boolean).join(" | "));
}

async function inspectZip(buffer: Buffer, artifact: PreviewVerificationArtifactView): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const officeText = await inspectOfficeZip(zip, artifact);
  if (officeText) return officeText;
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const hazards = entries
    .map((entry) => (typeof (entry as { unsafeOriginalName?: unknown }).unsafeOriginalName === "string" ? (entry as { unsafeOriginalName: string }).unsafeOriginalName : entry.name))
    .filter((name) => name.startsWith("/") || name.split("/").includes(".."));
  const list = entries.slice(0, MAX_ARCHIVE_LIST_ENTRIES).map((entry) => entry.name);
  const snippets: string[] = [];
  for (const entry of entries) {
    if (snippets.length >= MAX_ARCHIVE_TEXT_FILES) break;
    if (!/\.(csv|html?|json|log|md|txt|xml|ya?ml)$/i.test(entry.name)) continue;
    snippets.push(`--- ${entry.name} ---\n${truncate(cleanText(await entry.async("string")), 4000)}`);
  }
  return [
    `Archive ${artifact.fileName}: ${entries.length} files${hazards.length > 0 ? `, unsafe paths: ${hazards.slice(0, 8).join(", ")}` : ""}`,
    `Entries:\n${list.join("\n")}${entries.length > list.length ? `\n... ${entries.length - list.length} more` : ""}`,
    snippets.length > 0 ? `Text excerpts:\n${snippets.join("\n")}` : "No text excerpts extracted."
  ].join("\n");
}

function readTarEntries(buffer: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= buffer.length && names.length < MAX_ARCHIVE_LIST_ENTRIES; ) {
    const name = buffer.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break;
    const sizeText = buffer.subarray(offset + 124, offset + 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeText || "0", 8) || 0;
    names.push(`${name} | ${size} bytes`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function inspectTar(buffer: Buffer, artifact: PreviewVerificationArtifactView): string {
  const tarBuffer = /\.(tgz|tar\.gz)$/i.test(artifact.fileName) ? zlib.gunzipSync(buffer) : buffer;
  const entries = readTarEntries(tarBuffer);
  return `Archive ${artifact.fileName}: ${entries.length} listed entries\n${entries.join("\n") || "No entries found."}`;
}

function inspectGenericBinary(buffer: Buffer, artifact: PreviewVerificationArtifactView): string {
  const head = buffer.subarray(0, 32);
  const ascii = head.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  return `Binary ${artifact.fileName}: ${buffer.byteLength} bytes, sha256=${crypto.createHash("sha256").update(buffer).digest("hex")}, magic=${head.toString("hex")}, ascii=${ascii}`;
}

export async function inspectProofArtifacts(artifacts: PreviewVerificationArtifactView[]): Promise<InspectedProofArtifacts> {
  const summaries: string[] = [];
  const textSections: string[] = [];
  const imageArtifacts = artifacts.filter(isImageArtifact);
  let totalText = 0;
  for (const artifact of artifacts) {
    const buffer = await fs.readFile(artifact.filePath).catch(() => null);
    summaries.push(artifactLine(artifact, buffer));
    if (!buffer || imageArtifacts.includes(artifact)) continue;
    let section = "";
    try {
      if (isPdf(artifact)) section = await inspectPdf(buffer, artifact);
      else if (isZipLike(artifact)) section = await inspectZip(buffer, artifact);
      else if (isTarLike(artifact)) section = inspectTar(buffer, artifact);
      else if (isTextLike(artifact)) section = truncate(cleanText(buffer.toString("utf8")));
      else section = inspectGenericBinary(buffer, artifact);
    } catch (error) {
      section = `Could not deeply inspect ${artifact.fileName}: ${error instanceof Error ? error.message : String(error)}\n${inspectGenericBinary(buffer, artifact)}`;
    }
    if (section && totalText < MAX_TOTAL_TEXT_CHARS) {
      const remaining = MAX_TOTAL_TEXT_CHARS - totalText;
      const clipped = truncate(section, remaining);
      totalText += clipped.length;
      textSections.push(`--- ${artifact.label} (${artifact.fileName}) ---\n${clipped}`);
    }
  }
  return {
    artifactSummary: summaries.join("\n"),
    textEvidence: textSections.join("\n\n"),
    imageArtifacts
  };
}
