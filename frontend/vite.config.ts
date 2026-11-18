import path from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";

const staticDir = path.join(import.meta.dirname, "../backend/folio/static");

/** One id per build, baked into the bundle and written to /version.json: the
 * running app compares the two to notice a deploy (useAppUpdate). */
const buildId = process.env.FOLIO_BUILD_ID || new Date().toISOString();

function versionFile(): Plugin {
  return {
    name: "folio-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: buildId }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), svgr(), versionFile()],
  define: { __FOLIO_BUILD__: JSON.stringify(buildId) },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: staticDir, emptyOutDir: true },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{ts,tsx}"] },
});
