import { defineConfig } from "@playwright/test";

// Run against a live stack: FOLIO_E2E_BASE_URL=http://localhost:8000 npx playwright test
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.FOLIO_E2E_BASE_URL ?? "http://localhost:8000",
    viewport: { width: 390, height: 844 },
  },
});
