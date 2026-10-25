import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack with the M4 worker (mock TTS) running;
// `make e2e` serves this at the configured 390x844 viewport.

test("playing a ready book shows the pause control and a running clock", async ({ page }) => {
  test.setTimeout(120_000); // ingest + first segments synthesize for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-player" } });
  expect(res.ok()).toBeTruthy();

  await page.goto("/upload");
  // epub2 is content-hash deduped across the shared test database, so this is
  // either a fresh ingest or an already-Ready duplicate — both end at Ready.
  await page.setInputFiles('input[type="file"]', "../backend/tests/fixtures/epub2.epub");
  await expect(page.getByRole("listitem").last()).toContainText("Ready", { timeout: 90_000 });

  await page.goto("/");
  await page.getByRole("link").filter({ hasText: "Ready" }).first().click();
  await expect(page).toHaveURL(/\/books\/[0-9a-f-]+$/);
  const bookId = new URL(page.url()).pathname.split("/").pop()!;

  await page.goto(`/player?book=${bookId}`);
  await page.getByRole("button", { name: "Play" }).click();

  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-elapsed")).not.toHaveText("0:00", { timeout: 30_000 });
});
