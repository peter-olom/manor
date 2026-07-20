import path from "node:path";
import { fileURLToPath } from "node:url";

export const sourceLabelNames = {
  fingerprint: "com.manor.source.fingerprint",
  head: "com.manor.source.head",
  dirty: "com.manor.source.dirty",
  builtAt: "com.manor.source.built-at"
};

const sourceProvenanceScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "source-provenance.sh");
const runtimeSourceServices = new Set([
  "butler", "worker", "egress", "preview-egress", "runtime-broker", "playwright"
]);

export function parseSourceProvenance(output, builtAt = null) {
  const [head, dirtyText, fingerprint] = output.trim().split("\t");
  if (!head || !fingerprint || (dirtyText !== "true" && dirtyText !== "false")) {
    throw new Error("Source provenance output was invalid.");
  }
  return {
    head,
    dirty: dirtyText === "true",
    fingerprint,
    builtAt
  };
}

export async function readSourceProvenance(commandOutput, sourceDir, cleanHead = null) {
  const args = [sourceProvenanceScript, sourceDir];
  if (cleanHead) args.push(cleanHead);
  return parseSourceProvenance(await commandOutput("bash", args));
}

export function sourceProvenanceEnv(provenance) {
  if (!provenance) return {};
  return {
    MANOR_SOURCE_HEAD: provenance.head,
    MANOR_SOURCE_DIRTY: String(provenance.dirty),
    MANOR_SOURCE_FINGERPRINT: provenance.fingerprint,
    MANOR_SOURCE_BUILT_AT: provenance.builtAt
  };
}

function labelValue(labels, name) {
  const value = typeof labels?.[name] === "string" ? labels[name].trim() : "";
  return value && value !== "unknown" ? value : null;
}

function labelBoolean(labels, name) {
  const value = labelValue(labels, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function compareSourceState(checkout, services) {
  if (services.length === 0) {
    return {
      relation: "unknown",
      summary: "No running source-built Manor services were found."
    };
  }

  if (services.some((service) => !service.fingerprint || !service.head || service.dirty === null)) {
    return {
      relation: "unknown",
      summary: "At least one running Manor service does not include source provenance. Restart Manor once to establish it."
    };
  }

  const fingerprints = new Set(services.map((service) => service.fingerprint));
  if (fingerprints.size !== 1) {
    return {
      relation: "inconsistent",
      summary: "Running Manor services were built from different source states."
    };
  }

  const runtime = services[0];
  if (runtime.fingerprint === checkout.fingerprint) {
    return {
      relation: "matches_checkout",
      summary: checkout.dirty
        ? "The running Manor services match the active checkout, including its pending local changes."
        : "The running Manor services match the clean active checkout."
    };
  }

  if (runtime.head === checkout.head && runtime.dirty === false && checkout.dirty === true) {
    return {
      relation: "clean_head_fallback",
      summary: "The running Manor services use clean HEAD; the pending local changes are not live."
    };
  }

  return {
    relation: "differs_from_checkout",
    summary: "The running Manor services were built from a different source state than the active checkout."
  };
}

async function readCheckoutSourceState(commandOutput, manorDir) {
  const [provenance, status] = await Promise.all([
    readSourceProvenance(commandOutput, manorDir),
    commandOutput("git", ["status", "--short", "--untracked-files=normal"], 50_000)
  ]);
  const allChanges = status.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return {
    ...provenance,
    changedFileCount: allChanges.length,
    changedFiles: allChanges.slice(0, 200),
    changedFilesTruncated: allChanges.length > 200
  };
}

async function readRunningSourceServices(commandOutput, composeProjectName, runtimeSourceServices) {
  const listed = await commandOutput("docker", [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${composeProjectName}`,
    "--quiet"
  ]).catch(() => "");
  const containerIds = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (containerIds.length === 0) return [];

  const inspected = JSON.parse(await commandOutput("docker", ["inspect", ...containerIds], 2_000_000));
  return inspected
    .map((container) => {
      const labels = container?.Config?.Labels ?? {};
      const service = labelValue(labels, "com.docker.compose.service");
      if (!service || !runtimeSourceServices.has(service)) return null;
      return {
        service,
        containerId: typeof container.Id === "string" ? container.Id.slice(0, 12) : null,
        imageId: typeof container.Image === "string" ? container.Image : null,
        startedAt: typeof container.State?.StartedAt === "string" ? container.State.StartedAt : null,
        head: labelValue(labels, sourceLabelNames.head),
        dirty: labelBoolean(labels, sourceLabelNames.dirty),
        fingerprint: labelValue(labels, sourceLabelNames.fingerprint),
        builtAt: labelValue(labels, sourceLabelNames.builtAt)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.service.localeCompare(right.service));
}

export async function readManorSourceState({ commandOutput, manorDir, composeProjectName }) {
  const [checkout, services] = await Promise.all([
    readCheckoutSourceState(commandOutput, manorDir),
    readRunningSourceServices(commandOutput, composeProjectName, runtimeSourceServices)
  ]);
  return {
    ok: true,
    checkout,
    runtime: {
      services,
      ...compareSourceState(checkout, services)
    }
  };
}
