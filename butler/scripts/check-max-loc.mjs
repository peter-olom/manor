import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_LOC = 1500;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const allowedExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"]);
const excludedSegments = new Set([".git", "node_modules", "dist", "artifacts", "state", "test-results", "repos"]);

function listFilesFromFs(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (excludedSegments.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesFromFs(rootDir, absolutePath));
      continue;
    }

    results.push(path.relative(rootDir, absolutePath));
  }

  return results;
}

function countLines(source) {
  if (!source) {
    return 0;
  }

  let lines = 0;
  for (const char of source) {
    if (char === "\n") {
      lines += 1;
    }
  }
  return source.endsWith("\n") ? lines : lines + 1;
}

function shouldCheck(relativePath) {
  if (!relativePath || relativePath.endsWith(".css")) {
    return false;
  }

  const extension = path.extname(relativePath);
  if (!allowedExtensions.has(extension)) {
    return false;
  }

  const segments = relativePath.split(path.sep);
  return !segments.some((segment) => excludedSegments.has(segment));
}

const listedFiles = (() => {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8"
    })
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return listFilesFromFs(repoRoot);
  }
})();

const violations = listedFiles
  .filter(shouldCheck)
  .map((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    return {
      relativePath,
      lines: countLines(source)
    };
  })
  .filter((entry) => entry.lines > MAX_LOC)
  .sort((left, right) => right.lines - left.lines || left.relativePath.localeCompare(right.relativePath));

if (violations.length === 0) {
  console.log(`Max LOC check passed. No non-CSS source file exceeds ${MAX_LOC} lines.`);
  process.exit(0);
}

console.error(`Max LOC check failed. Break these files into smaller modules before merging:`);
for (const violation of violations) {
  console.error(`- ${violation.lines} ${violation.relativePath}`);
}
process.exit(1);
