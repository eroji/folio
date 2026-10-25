import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack with the M4 worker (mock TTS) running;
// `make e2e` serves this at the configured 390x844 viewport.

test("playing a ready book shows the pause control and a running clock", async ({ page }) => {
  test.setTimeout(120_000); // ingest + first segments synthesize for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-player" } });
  expect(res.ok()).toBeTruthy();

  // Earlier specs leave Ready books in the shared catalog; use one instead of
  // uploading (which would collide with the upload spec's fixture).
  await page.goto("/");
  await page.getByRole("link").filter({ hasText: "Ready" }).first().click();
  await expect(page).toHaveURL(/\/books\/[0-9a-f-]+$/);
  const bookId = new URL(page.url()).pathname.split("/").pop()!;

  await page.goto(`/player?book=${bookId}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();

  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player-elapsed")).not.toHaveText("0:00", { timeout: 30_000 });
});
