import { promises as fs } from "node:fs";
import path from "node:path";

import type { PairComposerSuggestion } from "../shared/pairing.js";

const LIMIT = 32;
const VISITED_DIRECTORY_LIMIT = 256;
const EXCLUDED = new Set([".git", ".hg", ".svn", "node_modules", ".next", "dist", "build", "coverage", ".cache"]);

function matches(query: string, name: string, relative: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return name.toLowerCase().includes(needle) || relative.toLowerCase().includes(needle);
}

export async function listComposerFileSuggestions(root: string, query: string): Promise<PairComposerSuggestion[]> {
  const workspace = await fs.realpath(root);
  const results: PairComposerSuggestion[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: workspace, depth: 0 }];
  const maxDepth = query.length >= 2 ? 5 : 2;
  let visitedDirectories = 0;

  while (queue.length > 0 && results.length < LIMIT && visitedDirectories < VISITED_DIRECTORY_LIMIT) {
    const current = queue.shift()!;
    visitedDirectories += 1;
    const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, entry.name);
      const relative = path.relative(workspace, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const isDirectory = entry.isDirectory();
      if ((entry.isFile() || isDirectory) && matches(query, entry.name, relative)) {
        results.push({
          id: `file:${absolute}`,
          kind: isDirectory ? "directory" : "file",
          label: entry.name,
          detail: relative,
          insertText: `@${relative}`,
          inputItem: { type: "file", name: relative, path: absolute }
        });
      }
      if (isDirectory && current.depth < maxDepth && results.length < LIMIT) {
        queue.push({ directory: absolute, depth: current.depth + 1 });
      }
      if (results.length >= LIMIT) break;
    }
  }
  return results;
}
