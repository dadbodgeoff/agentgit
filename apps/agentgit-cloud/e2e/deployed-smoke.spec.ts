import { expect, test } from "@playwright/test";

test("deployed cloud smoke covers public health, marketing, and sign-in surfaces", async ({ page, request }) => {
  const healthResponse = await request.get("/api/v1/healthz");
  expect(healthResponse.ok()).toBeTruthy();
  const healthPayload = (await healthResponse.json()) as {
    service?: string;
    status?: string;
    checks?: Array<{ id: string; level: string }>;
  };
  expect(healthPayload.service).toBe("agentgit-cloud");
  expect(healthPayload.status).not.toBe("fail");
  expect(healthPayload.checks?.some((check) => check.id === "cloud_database")).toBe(true);

  await page.goto("/");
  await expect(page).toHaveTitle(/AgentGit/);
  await expect(page.locator("body")).not.toContainText(/Application error|Unhandled Runtime Error/i);

  await page.goto("/pricing");
  await expect(
    page.getByRole("heading", { name: /Price the control plane by the amount of governed software/i }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Unhandled Runtime Error/i);

  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Application error|Unhandled Runtime Error/i);
});
