import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const staticDir = path.join(import.meta.dirname, "../backend/folio/static");

// emptyOutDir wipes the tracked .gitkeep that marks the static dir in git;
// restore it after the build without ever changing its contents.
let gitkeepSaved: Buffer | null = null;
const keepGitkeep = {
  name: "keep-gitkeep",
  buildStart(): void {
    const p = path.join(staticDir, ".gitkeep");
    gitkeepSaved = existsSync(p) ? readFileSync(p) : null;
  },
  closeBundle(): void {
    const p = path.join(staticDir, ".gitkeep");
    if (gitkeepSaved && !existsSync(p)) writeFileSync(p, gitkeepSaved);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), keepGitkeep],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { outDir: staticDir, emptyOutDir: true },
  test: { environment: "jsdom", globals: true, include: ["src/**/*.test.{ts,tsx}"] },
});
