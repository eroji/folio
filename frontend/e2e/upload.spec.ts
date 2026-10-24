import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true); `make e2e` runs
// this at the configured 390x844 viewport against the API origin.

test("uploading an EPUB reaches Ready without a reload", async ({ page }) => {
  test.setTimeout(120_000); // the worker ingests for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-user" } });
  expect(res.ok()).toBeTruthy();

  await page.goto("/upload");
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub3.epub");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByText("Processing")).toBeVisible();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 90_000 });

  await page.goto("/");
  // The status filter also contains the word "Ready", so assert on the card link.
  await expect(page.getByRole("link").filter({ hasText: "Ready" }).first()).toBeVisible();
});
