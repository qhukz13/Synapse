import { test, expect } from "@playwright/test";
test("shows real dashboard recommendations and persists resource completion", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Next lessons" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Learning progress" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Prerequisites help order suggestions/),
  ).toBeVisible();
  await page.getByRole("link", { name: /Resources/ }).click();
  const item = page.locator(".dashboard-resources li").first();
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: /mark completed/i }).click();
  await expect(
    item.getByRole("button", { name: /mark uncompleted/i }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator(".dashboard-resources li")
      .first()
      .getByRole("button", { name: /mark uncompleted/i }),
  ).toBeVisible();
  await page
    .locator(".dashboard-resources li")
    .first()
    .getByRole("button", { name: /mark uncompleted/i })
    .click();
});

test("starts, pauses, resumes and persists a study timer", async ({ page }) => {
  await page.goto("/");
  const timer = page.getByRole("contentinfo", { name: "Study timer" });
  await timer.getByRole("button", { name: "Start session" }).click();
  await expect(timer.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(timer.locator("output")).toBeVisible();
  await expect(
    timer.getByRole("progressbar", { name: "Daily streak qualification" }),
  ).toBeVisible();
  await timer.getByRole("button", { name: "Pause" }).click();
  await expect(timer.getByRole("button", { name: "Resume" })).toBeVisible();
  await timer.getByRole("button", { name: "Resume" }).click();
  await expect(timer.getByRole("button", { name: "Finish" })).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("contentinfo", { name: "Study timer" })
      .getByRole("button", { name: "Finish" }),
  ).toBeVisible();
  await page
    .getByRole("contentinfo", { name: "Study timer" })
    .getByRole("button", { name: "Finish" })
    .click();
  const finishDialog = page.getByRole("dialog", {
    name: "Wrap up this session",
  });
  await expect(finishDialog).toBeVisible();
  await finishDialog
    .getByLabel("Session note")
    .fill("Reviewed the material; continue with gradient descent.");
  await finishDialog
    .getByRole("button", { name: "Save note & finish" })
    .click();
  await expect(
    page
      .getByRole("contentinfo", { name: "Study timer" })
      .getByRole("button", { name: "Start session" }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Study sessions/ }).click();
  await expect(
    page.getByRole("heading", { name: "Study sessions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent sessions" }),
  ).toBeVisible();
  await expect(page.locator(".session-note").first()).toHaveText(
    "Reviewed the material; continue with gradient descent.",
  );
});
test("elects one timer leader and hands the heartbeat to another tab", async ({
  page,
  context,
}) => {
  test.setTimeout(30_000);
  const other = await context.newPage();
  const pages = [page, other];
  const heartbeats: import("@playwright/test").Page[] = [];
  for (const tab of pages) {
    tab.on("request", (request) => {
      if (
        request.url().includes("/api/sessions/") &&
        request.url().endsWith("/heartbeat")
      )
        heartbeats.push(tab);
    });
    await tab.goto("/");
  }
  await page
    .getByRole("contentinfo", { name: "Study timer" })
    .getByRole("button", { name: "Start session" })
    .click();
  await expect(
    page
      .getByRole("contentinfo", { name: "Study timer" })
      .getByRole("button", { name: "Finish" }),
  ).toBeVisible();
  await expect(
    other
      .getByRole("contentinfo", { name: "Study timer" })
      .getByRole("button", { name: "Finish" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => heartbeats.length, { timeout: 3_000 }).toBe(1);
  const leader = heartbeats[0]!;
  const follower = leader === page ? other : page;
  await leader.close();
  await expect
    .poll(() => heartbeats.length, { timeout: 10_000 })
    .toBeGreaterThan(1);
  await follower
    .getByRole("contentinfo", { name: "Study timer" })
    .getByRole("button", { name: "Finish" })
    .click();
  await follower
    .getByRole("dialog", { name: "Wrap up this session" })
    .getByRole("button", { name: "Finish without note" })
    .click();
  await expect(
    follower
      .getByRole("contentinfo", { name: "Study timer" })
      .getByRole("button", { name: "Start session" }),
  ).toBeVisible();
});

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
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
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
  await item.getByLabel("Difficulty").selectOption("intermediate");
  await expect(item.getByLabel("Approve this file")).toBeDisabled();
  await item.getByRole("button", { name: "Update preview" }).click();
  await expect(
    item.getByText(/Entered by you: difficulty intermediate/),
  ).toBeVisible();
  await expect(item.getByText(/difficulty: intermediate/)).toBeVisible();
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
  const source = await page.evaluate(async () =>
    fetch("/api/topics/01-test-a-prediction/source").then((response) =>
      response.json(),
    ),
  );
  expect(source.text).toContain("difficulty: intermediate");
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
