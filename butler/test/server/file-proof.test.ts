import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { handleHarnessProofAction } from "../../src/server/codex-harness-proof.js";
import { inspectProofArtifacts } from "../../src/server/proof-artifact-inspector.js";
import { ButlerStateStore } from "../../src/server/state-store.js";

function createPdfBuffer(text: string): Buffer {
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

test("harness file proof records a durable file artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-file-proof-"));
  const sourcePath = path.join(dir, "result.json");
  const artifactsDir = path.join(dir, "artifacts");
  await writeFile(sourcePath, '{"ok":true}\n', "utf8");
  const store = new ButlerStateStore(path.join(dir, "state.json"));

  const result = await handleHarnessProofAction({
    action: "proof.file",
    params: { filePath: sourcePath, label: "Result export" },
    capability: { threadId: "thread-1", cwd: dir } as never,
    thread: { id: "thread-1" } as never,
    store,
    artifactsDir,
    resolveWorkspaceProject: () => ({ id: "project-1", label: "Project One" })
  });

  assert.ok(result);
  const proof = store.getLatestPreviewProofForThread("thread-1");
  assert.ok(proof);
  assert.equal(proof.previewTitle, "File proof: Result export");
  assert.equal(proof.verification.artifacts[0]?.kind, "file");
  assert.equal(proof.verification.artifacts[0]?.label, "Result export");
  assert.equal(proof.verification.artifacts[0]?.contentType, "application/json");
  await stat(proof.verification.artifacts[0]!.filePath);
});

test("proof artifact inspector extracts Office text and archive listings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "manor-proof-inspect-"));
  const docxPath = path.join(dir, "summary.docx");
  const archivePath = path.join(dir, "bundle.zip");
  const pdfPath = path.join(dir, "invoice.pdf");

  const docx = new JSZip();
  docx.file("word/document.xml", "<w:document><w:body><w:p><w:t>Quarterly revenue export passed validation</w:t></w:p></w:body></w:document>");
  await writeFile(docxPath, await docx.generateAsync({ type: "nodebuffer" }));

  const archive = new JSZip();
  archive.file("README.md", "# Bundle\n\nContains signed release notes.");
  archive.file("../escape.txt", "unsafe");
  await writeFile(archivePath, await archive.generateAsync({ type: "nodebuffer" }));
  await writeFile(pdfPath, createPdfBuffer("Invoice PDF proof accepted"));

  const inspection = await inspectProofArtifacts([
    {
      kind: "file",
      label: "Office proof",
      fileName: "summary.docx",
      filePath: docxPath,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: null,
      url: null,
      downloadUrl: null,
      availability: "available",
      retainedUntilAt: null,
      expiredAt: null
    },
    {
      kind: "file",
      label: "PDF proof",
      fileName: "invoice.pdf",
      filePath: pdfPath,
      contentType: "application/pdf",
      sizeBytes: null,
      url: null,
      downloadUrl: null,
      availability: "available",
      retainedUntilAt: null,
      expiredAt: null
    },
    {
      kind: "file",
      label: "Archive proof",
      fileName: "bundle.zip",
      filePath: archivePath,
      contentType: "application/zip",
      sizeBytes: null,
      url: null,
      downloadUrl: null,
      availability: "available",
      retainedUntilAt: null,
      expiredAt: null
    }
  ]);

  assert.match(inspection.textEvidence, /Quarterly revenue export passed validation/);
  assert.match(inspection.textEvidence, /Invoice PDF proof accepted/);
  assert.match(inspection.textEvidence, /README\.md/);
  assert.match(inspection.textEvidence, /unsafe paths/);
  assert.match(inspection.artifactSummary, /sha256=/);
});
