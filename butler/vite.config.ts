import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __MANOR_VERSION__: JSON.stringify(packageMetadata.version)
  },
  server: {
    allowedHosts: true
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 700
  }
});
