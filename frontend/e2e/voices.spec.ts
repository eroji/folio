import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true, TTS pointed at
// the mock server whose pinned voice list is ashley-en). Written by plan
// Task D, run by the lead via `make e2e`.

test("the narrator voice override persists across a reload", async ({ page }) => {
  test.setTimeout(180_000); // real ingest

  const login = await page.request.post("/api/v1/test/login", {
    data: { username: "e2e-voices", role: "admin" },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/upload");
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub3.epub");
  const row = page
    .getByRole("listitem")
    .filter({ hasText: /epub3\.epub|The Lighthouse at Low Tide/ });
  await expect(row).toContainText(/Ready|already in your library/i, { timeout: 90_000 });
  await row.getByRole("link").first().click();

  // Direction D: the book page's narrator is set only from the ⋮ menu.
  const openNarrator = async () => {
    await page.getByRole("button", { name: "More options for this book" }).click();
    await page.getByRole("menuitem", { name: "Narrator voice…" }).click();
  };
  const dialog = page.getByRole("dialog", { name: "Narrator voice" });
  await openNarrator();
  const option = dialog.getByRole("button", { name: "Ashley", exact: true });
  await expect(option).toBeVisible();
  const patched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/books/") &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await option.click();
  await patched;
  await openNarrator();
  await expect(dialog.getByRole("button", { name: "Ashley", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.reload();
  await openNarrator();
  await expect(dialog.getByRole("button", { name: "Ashley", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The primary action starts the shared player (the bar at the bottom).
  await expect(page.getByRole("button", { name: /Play|Resume/ })).toBeVisible();
});
