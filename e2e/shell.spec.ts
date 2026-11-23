import { test, expect } from "@playwright/test";
test("opens Synapse and reaches local API through the proxy", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Synapse", { exact: true }).first(),
  ).toBeVisible();
  expect(await (await request.get("/api/health")).json()).toMatchObject({
    ok: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
