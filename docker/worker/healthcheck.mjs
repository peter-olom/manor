import net from "node:net";

const socketPath = process.env.WORKER_PI_RPC_SOCKET ?? "/worker-runtime/pi-rpc.sock";
const terminalPort = Number.parseInt(process.env.WORKER_TTYD_PORT ?? "7681", 10);

function canConnect(options) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(options);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("healthcheck timed out"));
    }, 2000);

    connection.once("connect", () => {
      clearTimeout(timer);
      connection.end();
      resolve();
    });
    connection.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

try {
  await Promise.all([
    canConnect({ path: socketPath }),
    canConnect({ host: "127.0.0.1", port: terminalPort }),
  ]);
} catch {
  process.exitCode = 1;
}
