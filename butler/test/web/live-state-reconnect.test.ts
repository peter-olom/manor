import test from "node:test";
import assert from "node:assert/strict";

import { __liveStateTestHooks } from "../../src/web/live-state.js";

type TimerTask = {
  at: number;
  callback: () => void;
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, EventListener>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }
}

function installFakeBrowserTimers() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, TimerTask>();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalEventSource = globalThis.EventSource;
  const originalDateNow = Date.now;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay: number) {
        const id = nextId++;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      }
    }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "hidden",
      addEventListener() {}
    }
  });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  Date.now = () => now;

  return {
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        const [id, task] = due;
        timers.delete(id);
        now = task.at;
        task.callback();
      }
      now = end;
    },
    restore() {
      __liveStateTestHooks.resetForTest();
      Date.now = originalDateNow;
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: originalEventSource });
      FakeEventSource.instances = [];
    }
  };
}

test("transient live update reconnects do not surface the disconnect toast state", () => {
  const browser = installFakeBrowserTimers();
  try {
    __liveStateTestHooks.resetForTest();
    __liveStateTestHooks.markTransportAliveForTest();

    __liveStateTestHooks.scheduleReconnectForTest("Live updates disconnected");
    assert.equal(__liveStateTestHooks.getTransportSnapshot().reconnecting, true);
    assert.equal(__liveStateTestHooks.getTransportSnapshot().disconnected, false);

    browser.advance(__liveStateTestHooks.disconnectNoticeDelayMs - 1);
    assert.equal(__liveStateTestHooks.getTransportSnapshot().disconnected, false);

    __liveStateTestHooks.markTransportAliveForTest();
    assert.equal(__liveStateTestHooks.getTransportSnapshot().connected, true);
    assert.equal(__liveStateTestHooks.getTransportSnapshot().disconnected, false);
  } finally {
    browser.restore();
  }
});

test("persistent live update reconnects still surface the disconnect toast state", () => {
  const browser = installFakeBrowserTimers();
  try {
    __liveStateTestHooks.resetForTest();
    __liveStateTestHooks.markTransportAliveForTest();

    __liveStateTestHooks.scheduleReconnectForTest("Live updates disconnected");
    browser.advance(__liveStateTestHooks.disconnectNoticeDelayMs);

    const transport = __liveStateTestHooks.getTransportSnapshot();
    assert.equal(transport.connected, false);
    assert.equal(transport.reconnecting, true);
    assert.equal(transport.disconnected, true);
    assert.equal(transport.lastError, "Live updates disconnected");
  } finally {
    browser.restore();
  }
});

test("failed background resyncs reuse the disconnect notice grace period", () => {
  const browser = installFakeBrowserTimers();
  try {
    __liveStateTestHooks.resetForTest();
    __liveStateTestHooks.markTransportAliveForTest();

    __liveStateTestHooks.handleVisiblePageResyncFailureForTest(new Error("bootstrap timed out"));

    assert.equal(__liveStateTestHooks.getTransportSnapshot().reconnecting, true);
    assert.equal(__liveStateTestHooks.getTransportSnapshot().disconnected, false);

    browser.advance(__liveStateTestHooks.disconnectNoticeDelayMs);
    assert.equal(__liveStateTestHooks.getTransportSnapshot().disconnected, true);
  } finally {
    browser.restore();
  }
});
