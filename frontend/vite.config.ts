import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import tailwindcss from "@tailwindcss/vite";

const staticDir = path.join(import.meta.dirname, "../backend/folio/static");

export default defineConfig({
  plugins: [react(), tailwindcss(), svgr()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: staticDir, emptyOutDir: true },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{ts,tsx}"] },
});
