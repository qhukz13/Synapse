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
  await expect(page.locator(".note-properties")).toBeVisible();
  const properties = page.locator(".note-properties");
  await expect(properties).toContainText("machine-learning");
  await expect(
    properties.getByRole("link", { name: "Dot Products" }),
  ).toBeVisible();
  await page.getByText(/^Properties \(\d+\)$/).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Prerequisites$/ })
    .click();
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

test("preserves a draft when a second editor saves first", async ({
  page,
  context,
}, info) => {
  const other = await context.newPage();
  const route = "/t/linear-regression/edit";
  await Promise.all([page.goto(route), other.goto(route)]);
  const draft = page.getByRole("textbox", { name: "Markdown source" });
  const second = other.getByRole("textbox", { name: "Markdown source" });
  await expect(draft).toBeVisible({ timeout: 20000 });
  await expect(second).toBeVisible({ timeout: 20000 });
  await draft.press("Control+End");
  await page.keyboard.insertText(
    "\nDraft waiting for comparison " + info.project.name,
  );
  await second.press("Control+End");
  await other.keyboard.insertText(
    "\nSaved through the second editor " + info.project.name,
  );
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(other.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Compare versions" }),
  ).toBeVisible();
  await expect(page.getByText("Your draft is still open above.")).toBeVisible();
  await expect(draft).toContainText(
    "Draft waiting for comparison " + info.project.name,
  );
  await other.close();
});

test("reviews a course preview and undoes the approved migration", async ({
  page,
}) => {
  await page.goto("/health");
  const review = page.getByRole("region", {
    name: "Vault repairs and migrations",
  });
  await review.getByLabel("Workflow").selectOption("python-course-migration");
  const item = review
    .locator(".change-item")
    .filter({ hasText: "01 - Test a Prediction.md" });
  await item.locator("summary").click();
  await expect(item.getByText("type: lesson", { exact: false })).toBeVisible();
  await item.getByLabel("Approve this file").check();
  await expect(
    review.getByRole("button", { name: "Apply approved changes" }),
  ).toBeDisabled();
  await review.getByLabel("Confirm changes to 1 file").check();
  await review.getByRole("button", { name: "Apply approved changes" }).click();
  const result = review
    .getByRole("listitem")
    .filter({ hasText: "01 - Test a Prediction.md" })
    .filter({ hasText: "applied" });
  await expect(result).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await result.getByRole("button", { name: "Undo this change" }).click();
  await expect(
    review
      .getByRole("listitem")
      .filter({ hasText: "01 - Test a Prediction.md" })
      .filter({ hasText: "reverted" })
      .first(),
  ).toBeVisible();
  await expect(item).toBeVisible();
});
