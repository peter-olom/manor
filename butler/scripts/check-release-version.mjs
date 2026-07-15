import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockMetadata = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const version = packageMetadata.version;
const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? null;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (typeof version !== "string" || !semverPattern.test(version)) {
  throw new Error(`Manor package version must be valid semantic versioning; received ${JSON.stringify(version)}`);
}

if (lockMetadata.version !== version || lockMetadata.packages?.[""]?.version !== version) {
  throw new Error(`butler/package-lock.json must match Manor version ${version}`);
}

if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match Manor version v${version}`);
}

console.log(`Manor release version v${version}${tag ? ` matches ${tag}` : " is valid"}.`);
