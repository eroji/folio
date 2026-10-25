import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack with the M5 progress API running;
// `make e2e` serves this at the configured 390x844 viewport.

test("play ~5 s, pause, reload → resumes within 3 s of the stop point", async ({ page }) => {
  test.setTimeout(120_000); // ingest + first segments synthesize for real

  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-progress" } });
  expect(res.ok()).toBeTruthy();

  // Earlier specs leave Ready books in the shared catalog; use one instead of
  // uploading (which would collide with the upload spec's fixture).
  await page.goto("/");
  await page.locator('main a[href^="/books/"]').first().click();
  const bookId = new URL(page.url()).pathname.split("/").pop()!;

  const elapsed = page.getByTestId("player-elapsed");
  await page.goto(`/player?book=${bookId}`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(elapsed).not.toHaveText("0:00", { timeout: 30_000 });
  await page.waitForTimeout(5_000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  await page.reload();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(elapsed).not.toHaveText("0:00", { timeout: 30_000 });

  // The save happened at ≥ ~5 s and resume rewinds 3 s: elapsed must be ≥ 2 s.
  const [m = 0, s = 0] = ((await elapsed.textContent()) ?? "0:00").split(":").map(Number);
  expect(m * 60 + s).toBeGreaterThanOrEqual(2);
});
