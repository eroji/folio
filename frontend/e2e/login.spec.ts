import { expect, test } from "@playwright/test";

// Requires the compose.test.yaml stack (FOLIO_TEST_MODE=true); the
// POST /api/v1/test/login endpoint is owned by plan Task 3.

test("test-mode session lands on the empty library", async ({ page }) => {
  const res = await page.request.post("/api/v1/test/login", {
    data: { username: "e2e-user" },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No books yet" })).toBeVisible();
  await expect(page.getByText("Upload your first EPUB, PDF or Kindle file.")).toBeVisible();
});

test("bad credentials show the server error inline", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("nobody");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Incorrect username or password");
});
