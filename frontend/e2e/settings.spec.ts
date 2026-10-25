import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE) running; `make e2e`
// serves this at the configured 390x844 viewport. Settings persist server-side,
// so a reload must show the saved speed.

test("a changed playback speed persists across a reload", async ({ page }) => {
  const res = await page.request.post("/api/v1/test/login", { data: { username: "e2e-settings" } });
  expect(res.ok()).toBeTruthy();

  await page.goto("/settings");
  const speed = page.getByLabel("Default playback speed");
  await expect(speed).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/me/settings") &&
      response.request().method() === "PUT" &&
      response.ok(),
  );
  await speed.selectOption("1.5");
  await saved;

  await page.reload();
  await expect(page.getByLabel("Default playback speed")).toHaveValue("1.5");
});
