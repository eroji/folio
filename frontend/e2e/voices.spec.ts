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

  // The book page opens the voice picker from the narrator icon button.
  const voiceButton = page.getByRole("button", { name: /Narrator voice/ });
  await voiceButton.click();
  const option = page.getByRole("menuitemradio", { name: /Ashley/ }).first();
  await expect(option).toBeVisible();
  const patched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/books/") &&
      response.request().method() === "PATCH" &&
      response.ok(),
  );
  await option.click();
  await patched;
  await page.getByRole("button", { name: /Narrator voice/ }).click();
  await expect(
    page.getByRole("menuitemradio", { name: /Ashley/ }).first(),
  ).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await page.getByRole("button", { name: /Narrator voice/ }).click();
  await expect(
    page.getByRole("menuitemradio", { name: /Ashley/ }).first(),
  ).toHaveAttribute("aria-checked", "true");

  // The primary action starts the shared player (the panel on desktop).
  await expect(page.getByRole("button", { name: /Play|Resume/ })).toBeVisible();
});
