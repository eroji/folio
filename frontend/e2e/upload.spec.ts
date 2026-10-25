import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true); `make e2e` runs
// this at the configured 390x844 viewport against the API origin.

test("uploading an EPUB reaches Ready without a reload", async ({ page }) => {
  test.setTimeout(120_000); // the worker ingests for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-upload" } });
  expect(res.ok()).toBeTruthy();

  await page.goto("/upload");
  // epub2 is not used by any other spec, so this upload always ingests
  // (the fixture set is content-hash deduped across the shared test database).
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub2.epub");
  await expect(page.getByRole("progressbar")).toBeVisible();

  // Ingest can finish before the intermediate "Processing" state is painted,
  // so wait for the terminal, user-visible result instead. Only one file was
  // chosen, so the last row is this upload.
  const row = page.getByRole("listitem").last();
  await expect(row).toContainText("Ready", { timeout: 90_000 });

  await page.goto("/");
  await expect(
    page.locator('main a[href^="/books/"]').first(),
  ).toBeVisible({ timeout: 15_000 });
});
