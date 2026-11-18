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

  // Fresh database: the row shows the extracted title and status. Reused
  // database: the same bytes are a duplicate and the row shows the filename
  // plus a link to the existing book. Both are valid entries to edit.
  const row = page
    .getByRole("listitem")
    .filter({ hasText: /epub3\.epub|The Lighthouse at Low Tide/ });
  await expect(row).toContainText(/Ready|already in your library/i, { timeout: 90_000 });
  await row.getByRole("link").first().click();

  // Phase 4 moved the management actions into the Manage tab.
  await page.getByRole("tab", { name: "Manage" }).click();
  await page.getByRole("link", { name: "Edit details" }).click();
  // Unique per run so a previous run's edit cannot satisfy the assertion.
  const editedTitle = `The Lighthouse at Low Tide ${Date.now()}`;
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(editedTitle);
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const heading = page.getByRole("heading", { name: editedTitle });
  await expect(heading).toBeVisible();

  // Reprocess through the API: the UI button is admin-only until the payload
  // exposes the uploader (see docs/DECISIONS.md).
  const bookId = new URL(page.url()).pathname.split("/")[2];
  const csrf = (await page.context().cookies()).find((c) => c.name === "folio_csrf")?.value;
  const reprocess = await page.request.post(`/api/v1/books/${bookId}/reprocess`, {
    headers: { "X-CSRF-Token": csrf ?? "" },
  });
  expect(reprocess.ok()).toBeTruthy();

  await page.reload();
  await page.getByRole("tab", { name: "Manage" }).click();
  await expect(page.getByText("Ready ·").first()).toBeVisible({ timeout: 90_000 });
  // The manual edit must survive the automatic re-ingest.
  await expect(page.getByRole("heading", { name: editedTitle })).toBeVisible();
});
