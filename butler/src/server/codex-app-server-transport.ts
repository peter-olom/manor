import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";

import WebSocket, { type RawData } from "ws";

export type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerTransport extends EventEmitter {
  private static readonly CONNECT_TIMEOUT_MS = 15_000;
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 10_000;
  private static readonly RECONNECT_BASE_DELAY_MS = 1_500;
  private static readonly RECONNECT_MAX_DELAY_MS = 15_000;

  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimeoutTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connected = false;
  private lastError: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly options?: {
      authTokenFile?: string | null;
      onReady?: () => Promise<void>;
      onClosed?: () => void;
    }
  ) {
    super();
  }

  start(): void {
    this.connect();
  }

  getState(): { connected: boolean; lastError: string | null } {
    return {
      connected: this.connected,
      lastError: this.lastError
    };
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not connected");
    }

    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not connected");
    }
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.socket?.close();
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const retryIndex = this.reconnectAttempt++;
    const baseDelay = Math.min(
      CodexAppServerTransport.RECONNECT_MAX_DELAY_MS,
      CodexAppServerTransport.RECONNECT_BASE_DELAY_MS * 2 ** retryIndex
    );
    const jitter = Math.min(750, Math.round(baseDelay * 0.2 * Math.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, baseDelay + jitter);
  }

  private armHeartbeat(socket: WebSocket): void {
    this.clearHeartbeatTimers();
    this.heartbeatIntervalTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearHeartbeatTimers();
        return;
      }

      try {
        socket.ping();
      } catch {
        socket.terminate();
        return;
      }

      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
      }
      this.heartbeatTimeoutTimer = setTimeout(() => {
        if (this.socket === socket) {
          this.lastError = "Codex app-server heartbeat timed out";
          this.emit("change");
        }
        socket.terminate();
      }, CodexAppServerTransport.HEARTBEAT_TIMEOUT_MS);
    }, CodexAppServerTransport.HEARTBEAT_INTERVAL_MS);
  }

  private markHeartbeatHealthy(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private readAuthHeaders(): Record<string, string> | undefined {
    const tokenPath = this.options?.authTokenFile ? path.resolve(this.options.authTokenFile) : null;
    if (!tokenPath) {
      return undefined;
    }

    const token = readFileSync(tokenPath, "utf8").trim();
    if (!token) {
      throw new Error("Codex app-server auth token is empty");
    }

    return {
      Authorization: `Bearer ${token}`
    };
  }

  private connect(): void {
    let headers: Record<string, string> | undefined;
    try {
      headers = this.readAuthHeaders();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit("change");
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(this.baseUrl, { headers });
    this.socket = socket;
    this.clearConnectTimeout();
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.socket !== socket || this.connected) {
        return;
      }

      this.lastError = "Timed out connecting to Codex app-server";
      this.emit("change");
      socket.terminate();
    }, CodexAppServerTransport.CONNECT_TIMEOUT_MS);

    socket.on("open", async () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }

      try {
        await this.call("initialize", {
          clientInfo: {
            name: "manor-butler",
            title: "Manor Butler",
            version: "0.1.0"
          },
          capabilities: {
            experimentalApi: true
          }
        });

        this.sendNotification("initialized", {});
        this.clearConnectTimeout();
        this.connected = true;
        this.lastError = null;
        this.reconnectAttempt = 0;
        this.armHeartbeat(socket);
        this.emit("change");
        await this.options?.onReady?.();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit("change");
        socket.close();
      }
    });

    socket.on("message", (buffer: RawData) => {
      if (this.socket !== socket) {
        return;
      }

      this.markHeartbeatHealthy(socket);
      try {
        const message = JSON.parse(buffer.toString()) as JsonRpcMessage;
        this.handleMessage(message);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.emit("change");
      }
    });

    socket.on("pong", () => {
      this.markHeartbeatHealthy(socket);
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }

      this.clearConnectTimeout();
      this.clearHeartbeatTimers();
      this.connected = false;
      this.socket = null;

      for (const pending of this.pending.values()) {
        pending.reject(new Error("Codex app-server connection closed"));
      }
      this.pending.clear();

      if (!this.lastError) {
        this.lastError = "Codex app-server connection closed";
      }
      this.options?.onClosed?.();
      this.scheduleReconnect();
      this.emit("change");
    });

    socket.on("error", (error: Error) => {
      if (this.socket !== socket) {
        return;
      }

      this.lastError = error.message;
      this.emit("change");
    });
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    this.emit("notification", message);
  }
}
