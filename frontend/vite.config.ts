import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";

const staticDir = path.join(import.meta.dirname, "../backend/folio/static");

export default defineConfig({
  plugins: [react(), svgr(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: staticDir, emptyOutDir: true },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{ts,tsx}"] },
});
