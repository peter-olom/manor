const MODEL_TIER_RANK: Record<string, number> = {
  max: 90,
  ultra: 80,
  pro: 70,
  plus: 60,
  code: 50,
  omni: 45,
  flash: 40,
  mini: 30,
  small: 20,
  preview: 10
};

function modelFamilyPrefix(id: string): string {
  return id.toLowerCase().match(/^[^0-9]+/)?.[0] ?? id.toLowerCase();
}

function modelVersionParts(id: string): number[] {
  return Array.from(id.matchAll(/\d+(?:\.\d+)*/g))
    .flatMap((match) => match[0].split(".").map((part) => Number(part)))
    .filter((value) => Number.isFinite(value));
}

function modelTierRank(id: string): number {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/g);
  return tokens.reduce((score, token) => Math.max(score, MODEL_TIER_RANK[token] ?? 0), 0);
}

function compareNumberArraysAscending(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] ?? -1;
    const rightPart = right[index] ?? -1;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function compareModelIdsAscending(left: string, right: string): number {
  const leftFamily = modelFamilyPrefix(left);
  const rightFamily = modelFamilyPrefix(right);
  if (leftFamily === rightFamily) {
    const versionOrder = compareNumberArraysAscending(modelVersionParts(left), modelVersionParts(right));
    if (versionOrder !== 0) return versionOrder;
    const tierOrder = modelTierRank(left) - modelTierRank(right);
    if (tierOrder !== 0) return tierOrder;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
