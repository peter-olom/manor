import path from "node:path";

import { createManorModelRegistry } from "./model-provider-config.js";
import { ModelUsageStore } from "./model-usage-store.js";

export function createModelUsageStore(options: {
  stateDir: string;
  butlerSessionRoots: string[];
  workerPiSessionRoot: string;
  codexHomeDir: string;
  piAuthPath: string;
}): ModelUsageStore {
  return new ModelUsageStore({
    dbPath: path.join(options.stateDir, "model-usage.sqlite"),
    butlerPiRoots: options.butlerSessionRoots,
    workerPiRoots: [options.workerPiSessionRoot],
    codexRoots: [path.join(options.codexHomeDir, "sessions"), path.join(options.codexHomeDir, "archived_sessions")],
    loadPiPricing: async () => {
      const registry = await createManorModelRegistry(options.piAuthPath);
      const models = registry.getAvailable();
      return {
        models,
        oauthKeys: new Set(models.filter((model) => registry.isUsingOAuth(model)).map((model) => `${model.provider}/${model.id}`))
      };
    }
  });
}
