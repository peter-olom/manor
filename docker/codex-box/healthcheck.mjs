import http from "node:http";

const port = Number.parseInt(process.env.CODEX_APP_SERVER_PORT ?? "8080", 10);
const req = http.get(
  {
    host: "127.0.0.1",
    port,
    path: "/readyz",
    timeout: 2000,
  },
  (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.on("error", () => process.exit(1));
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
