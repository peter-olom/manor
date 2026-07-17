export type RefreshScheduler = {
  request: (replacePending?: boolean) => void;
  dispose: () => void;
};

export function createRefreshScheduler(refresh: (signal: AbortSignal) => Promise<void>): RefreshScheduler {
  let disposed = false;
  let queued = false;
  let controller: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const request = (replacePending = false): void => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      if (replacePending) controller?.abort();
      return;
    }

    const currentController = new AbortController();
    controller = currentController;
    inFlight = refresh(currentController.signal)
      .catch(() => undefined)
      .finally(() => {
        if (controller === currentController) controller = null;
        inFlight = null;
        if (!disposed && queued) {
          queued = false;
          request();
        }
      });
  };

  return {
    request,
    dispose: () => {
      disposed = true;
      queued = false;
      controller?.abort();
    }
  };
}
