import { expect, test } from "@playwright/test";

// The panel only exists when the server sets FOLIO_TEST_MODE (compose.test.yaml),
// which is how this machine tests the UI without an LDAP directory.

test("test-mode panel signs in without LDAP", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Test username").fill("browser-user");
  await page.getByLabel("Test role").selectOption("admin");
  await page.getByRole("button", { name: "Test sign in" }).click();

  await page.waitForURL("**/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Admin" })).toBeVisible();
  // 390 px viewport: the phone header offers Search as an icon link.
  await expect(page.getByRole("banner").getByRole("link", { name: "Search" })).toBeVisible();
});
