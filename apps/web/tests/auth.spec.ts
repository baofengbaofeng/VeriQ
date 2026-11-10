import { test, expect } from "@playwright/test";

test("real setup, login, account, administration and one-time reset", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up VeriQ" }),
  ).toBeVisible();
  await page.getByTestId("installationSecret").fill("wrong-secret");
  await page.getByTestId("email").fill("browser-admin@example.com");
  await page.getByTestId("displayName").fill("Browser Administrator");
  await page.getByTestId("password").fill("Browser password 123!");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByRole("alert")).toContainText(
    "Installation secret is invalid",
  );
  await page.getByTestId("installationSecret").fill("browser-operator-secret");
  await page.getByTestId("setup-submit").click();
  await expect(
    page.getByRole("heading", { name: "Sign in to VeriQ" }),
  ).toBeVisible();
  await page.getByTestId("email").fill("browser-admin@example.com");
  await page.getByTestId("password").fill("incorrect");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("alert")).toContainText(
    "Email or password is incorrect",
  );
  await page.getByTestId("password").fill("Browser password 123!");
  const loginNavigations: string[] = [];
  const recordLoginNavigation = (frame: import("@playwright/test").Frame) => {
    if (frame === page.mainFrame())
      loginNavigations.push(new URL(frame.url()).pathname);
  };
  page.on("framenavigated", recordLoginNavigation);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-info")).toContainText(
    "Browser Administrator",
  );
  await expect(page.getByTestId("sessions")).toContainText("This session");
  expect(loginNavigations.filter((path) => path === "/account")).toHaveLength(
    1,
  );
  page.off("framenavigated", recordLoginNavigation);
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByTestId("email").fill("browser-user@example.com");
  await page.getByTestId("displayName").fill("Browser User");
  await page.getByTestId("password").fill("Initial password 123!");
  await page.getByTestId("create-user").click();
  const row = page.getByTestId("user-browser-user@example.com");
  await expect(row).toContainText("Browser User");
  await page
    .getByTestId("user-browser-admin@example.com")
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Create another enabled system administrator first",
  );
  await row.getByRole("button", { name: "Make admin", exact: true }).click();
  await expect(row).toContainText("System administrator");
  await row.getByRole("button", { name: "Remove admin", exact: true }).click();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(row).toContainText("Disabled");
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await row
    .getByRole("button", { name: "Revoke sessions", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Sessions revoked");
  await row.getByRole("button", { name: "Reset link", exact: true }).click();
  const link = await page.getByTestId("reset-url").inputValue();
  expect(link).toContain("/reset/confirm#token=");
  await page.screenshot({
    path: "../../.superpowers/cache/t02/admin-users.png",
    fullPage: true,
    mask: [page.getByTestId("reset-url")],
  });
  await page.getByTestId("logout").click();
  await expect(
    page.getByRole("heading", { name: "Sign in to VeriQ" }),
  ).toBeVisible();
  await page.goto(link);
  await page.getByTestId("newPassword").fill("Changed password 123!");
  await page.getByTestId("reset-confirm-submit").click();
  await expect(page.getByRole("status")).toContainText("Password updated");
  await page.getByRole("link", { name: "Sign in", exact: true }).last().click();
  await page.getByTestId("email").fill("browser-user@example.com");
  await page.getByTestId("password").fill("Changed password 123!");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-info")).toContainText("Browser User");
  await expect(
    page.getByRole("link", { name: "Users", exact: true }),
  ).toHaveCount(0);
  await page.goto("/admin/users");
  await expect(page.getByRole("alert")).toContainText(
    "System administrator permission",
  );
  await page.goto("/account");
  await page.getByTestId("currentPassword").fill("Changed password 123!");
  await page.getByTestId("newPassword").fill("Final password 123!");
  const passwordNavigations: string[] = [];
  const recordPasswordNavigation = (
    frame: import("@playwright/test").Frame,
  ) => {
    if (frame === page.mainFrame())
      passwordNavigations.push(new URL(frame.url()).pathname);
  };
  page.on("framenavigated", recordPasswordNavigation);
  await page.getByTestId("change-password").click();
  await expect(
    page.getByRole("heading", { name: "Sign in to VeriQ" }),
  ).toBeVisible();
  expect(passwordNavigations.filter((path) => path === "/login")).toHaveLength(
    1,
  );
  page.off("framenavigated", recordPasswordNavigation);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByTestId("email").fill("unknown@example.com");
  await page.getByTestId("reset-request-submit").click();
  await expect(page.getByRole("status")).toContainText(
    "If this account is eligible",
  );
  await page.goto(link);
  await page.getByTestId("newPassword").fill("Rejected password 123!");
  await page.getByTestId("reset-confirm-submit").click();
  await expect(page.getByRole("alert")).toContainText(
    "Reset link is invalid or expired",
  );
  await page.goto("/login");
  await page.getByTestId("email").fill("browser-user@example.com");
  await page.getByTestId("password").fill("Final password 123!");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("revoke-own").click();
  await expect(
    page.getByRole("heading", { name: "Sign in to VeriQ" }),
  ).toBeVisible();
  await page.goto("/reset/confirm");
  await expect(page.getByRole("alert")).toContainText("missing its token");
});
