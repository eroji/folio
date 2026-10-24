import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true); `make e2e` runs
// this at the configured 390x844 viewport against the API origin.

test("uploading an EPUB reaches Ready without a reload", async ({ page }) => {
  test.setTimeout(120_000); // the worker ingests for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-upload" } });
  expect(res.ok()).toBeTruthy();

  await page.goto("/upload");
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub3.epub");
  await expect(page.getByRole("progressbar")).toBeVisible();

  // Ingest can finish before the intermediate "Processing" state is painted,
  // so wait for the terminal, user-visible result instead.
  const row = page.getByRole("listitem").filter({ hasText: /The Lighthouse at Low Tide/ });
  await expect(row).toBeVisible({ timeout: 90_000 });
  await expect(row).toContainText("Ready");

  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /The Lighthouse at Low Tide/ }),
  ).toBeVisible({ timeout: 15_000 });
});
