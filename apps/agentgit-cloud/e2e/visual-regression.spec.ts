import { expect, test, type Page } from "@playwright/test";

const PUBLIC_VISUAL_ROUTES = [
  { path: "/", snapshot: "landing.png" },
  { path: "/pricing", snapshot: "pricing.png" },
  { path: "/docs", snapshot: "docs.png" },
  { path: "/sign-in", snapshot: "sign-in.png" },
] as const;

async function stabilizeVisuals(page: Page) {
  await page.addStyleTag({
    content: [
      "*, *::before, *::after {",
      "  animation-duration: 0s !important;",
      "  animation-delay: 0s !important;",
      "  transition-duration: 0s !important;",
      "  transition-delay: 0s !important;",
      "  caret-color: transparent !important;",
      "}",
    ].join("\n"),
  });
}

test.describe("public route visual regression", () => {
  for (const route of PUBLIC_VISUAL_ROUTES) {
    test(`${route.path} matches the approved baseline`, async ({ page }) => {
      await page.goto(route.path);
      await page.waitForLoadState("networkidle");
      await stabilizeVisuals(page);

      await expect(page).toHaveScreenshot(route.snapshot, {
        animations: "disabled",
        fullPage: true,
        maxDiffPixelRatio: 0.01,
      });
    });
  }
});
