import { defineConfig } from "@playwright/test";

// Run against a live stack: FOLIO_E2E_BASE_URL=http://localhost:8000 npx playwright test
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // Serial on purpose: specs share one seeded test database, and test-mode
  // login upserts a user by username (parallel workers would race the insert).
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.FOLIO_E2E_BASE_URL ?? "http://localhost:8000",
    viewport: { width: 390, height: 844 },
  },
});
