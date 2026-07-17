export function workerHarnessLabel(harness: string): string {
  if (harness === "pi") return "Pi";
  return harness;
}

export function workerProviderModelRoute(provider: string | null, model: string | null): string {
  const providerLabel = provider?.trim() || "the selected provider";
  const modelLabel = model?.trim() || "default";
  return provider && modelLabel.startsWith(`${provider}/`) ? modelLabel : `${providerLabel}/${modelLabel}`;
}
