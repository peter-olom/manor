import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BUMP_RANK = { patch: 0, minor: 1, major: 2 };
const NATURAL_FEATURE_SUBJECT = /^(?:add|create|enable|expose|implement|introduce|support)\b/i;
const CONVENTIONAL_FEATURE_SUBJECT = /^feat(?:\([^)]*\))?:/i;
const CONVENTIONAL_BREAKING_SUBJECT = /^[a-z][a-z0-9-]*(?:\([^)]*\))?!:/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*\S/im;
const RELEASE_AS_FOOTER = /^Release-As:\s*(patch|minor|major)\s*$/im;

export function classifyReleaseCommit(commit) {
  const subject = commit.subject.trim();
  const body = commit.body.trim();
  const explicit = body.match(RELEASE_AS_FOOTER)?.[1]?.toLowerCase();
  if (explicit === "patch" || explicit === "minor" || explicit === "major") return explicit;
  if (CONVENTIONAL_BREAKING_SUBJECT.test(subject) || BREAKING_FOOTER.test(body)) return "major";
  if (CONVENTIONAL_FEATURE_SUBJECT.test(subject) || NATURAL_FEATURE_SUBJECT.test(subject)) return "minor";
  return "patch";
}

export function resolveReleaseBump(commits) {
  if (commits.length === 0) throw new Error("No unreleased commits were found");
  return commits.reduce((highest, commit) => {
    const next = classifyReleaseCommit(commit);
    return BUMP_RANK[next] > BUMP_RANK[highest] ? next : highest;
  }, "patch");
}

function unreleasedCommits() {
  let latestTag = null;
  try {
    latestTag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], { encoding: "utf8" }).trim();
  } catch {
    latestTag = null;
  }
  const range = latestTag ? `${latestTag}..HEAD` : "HEAD";
  const output = execFileSync("git", ["log", range, "--format=%s%x1f%b%x1e"], { encoding: "utf8" });
  return output.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [subject = "", body = ""] = entry.split("\x1f");
    return { subject, body };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${resolveReleaseBump(unreleasedCommits())}\n`);
}
