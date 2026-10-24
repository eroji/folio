import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true); written by plan
// Task D, run by the lead via `make e2e`. Admin role so PATCH and reprocess
// are permitted even when an earlier spec already uploaded the fixture.

test("an edited title survives a reprocess", async ({ page }) => {
  test.setTimeout(180_000); // real ingest, possibly twice

  const login = await page.request.post("/api/v1/test/login", {
    data: { username: "e2e-metadata", role: "admin" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/upload");
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub3.epub");
  const row = page.getByRole("listitem").filter({ hasText: /The Lighthouse at Low Tide/ });
  // The fixture may already exist from upload.spec (shared serial database):
  // a duplicate upload links to the existing book instead of ingesting.
  await expect(row).toContainText(/Ready|already in your library/i, { timeout: 90_000 });

  await page.goto("/");
  await page.getByRole("link", { name: /The Lighthouse at Low Tide/ }).click();

  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("The Lighthouse at Low Tide");
  await page.getByLabel("Title").fill("The Lighthouse at Low Tide (Edited)");
  await page.getByRole("button", { name: "Save" }).click();

  const heading = page.getByRole("heading", { name: "The Lighthouse at Low Tide (Edited)" });
  await expect(heading).toBeVisible();

  // Reprocess through the API: the UI button is admin-only until the payload
  // exposes the uploader (see docs/DECISIONS.md).
  const bookId = new URL(page.url()).pathname.split("/")[2];
  const reprocess = await page.request.post(`/api/v1/books/${bookId}/reprocess`);
  expect(reprocess.ok()).toBeTruthy();

  await page.reload();
  await expect(page.getByText("Ready").first()).toBeVisible({ timeout: 90_000 });
  await expect(heading).toBeVisible();
});
