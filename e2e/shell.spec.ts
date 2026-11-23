import { test, expect } from "@playwright/test";
test("uses vault search, reads a note and follows a prerequisite", async ({
  page,
}) => {
  const outbound: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== "127.0.0.1"
    )
      outbound.push(url.host);
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Learning path" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search vault" })
    .fill("Linear Regression");
  await page
    .getByRole("link", { name: /Linear Regression/ })
    .first()
    .click();
  await expect(
    page
      .getByRole("heading", { name: "Linear Regression", exact: true })
      .first(),
  ).toBeVisible();
  await page.getByText("Prerequisites", { exact: true }).click();
  await page
    .getByRole("link", { name: /Dot Products/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Dot Products", exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(outbound).toEqual([]);
});
