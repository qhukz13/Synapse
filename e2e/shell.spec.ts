import { test, expect } from "@playwright/test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function isolatedBrowserVault() {
  try {
    return await readFile(
      join(tmpdir(), "synapse-browser-active-vault"),
      "utf8",
    );
  } catch {
    throw new Error("The isolated Playwright fixture vault was not found.");
  }
}

test("creates, autosaves and searches a scoped personal note", async ({
  page,
  context,
}, testInfo) => {
  const token = `synapse-note-${Date.now()}-${testInfo.project.name}`;
  const title = `Learning capture ${token}`;
  const sentence = `Уникальный сигнал ${token}`;
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill(title);
  await page
    .getByRole("combobox", { name: "Topic", exact: true })
    .selectOption("vectors");
  await expect(page.locator(".new-note-form > small")).toContainText(
    "Personal Notes/Topics/Vectors",
  );
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Markdown note" });
  await editor.fill(`${await editor.inputValue()}\n## Capture\n${sentence}\n`);
  await expect(
    page.locator('.personal-note-heading [role="status"]'),
  ).toHaveText("Saved", { timeout: 5_000 });
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Markdown note" }),
  ).toHaveValue(new RegExp(sentence));
  const noteUrl = page.url();
  const pagehideSentence = `Pagehide flush ${token}`;
  await editor.fill(`${await editor.inputValue()}\n${pagehideSentence}`);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(noteUrl);
  await expect(
    reopened.getByRole("textbox", { name: "Markdown note" }),
  ).toHaveValue(new RegExp(pagehideSentence));
  await reopened.getByRole("link", { name: "Vectors" }).click();
  await reopened.getByText(/^Personal notes \(\d+\)$/).click();
  const associatedNote = reopened.getByRole("link", {
    name: new RegExp(title),
  });
  await expect(associatedNote).toBeVisible();
  await expect(associatedNote.locator(".personal-note-snippet")).toContainText(
    sentence,
  );
  await reopened.goto("/notes");
  await reopened
    .getByRole("searchbox", { name: "Search personal notes" })
    .fill(token);
  const searchedNote = reopened.getByRole("link", { name: new RegExp(title) });
  await expect(searchedNote).toBeVisible();
  await expect(searchedNote.locator(".personal-note-snippet")).toContainText(
    sentence,
  );
});

test("creates a personal note directly from its topic", async ({
  page,
}, testInfo) => {
  const title = `Topic capture ${Date.now()} ${testInfo.project.name}`;
  await page.goto("/t/vectors");
  await page.getByText(/^Personal notes \(\d+\)$/).click();
  await page.getByRole("button", { name: "New note for this topic" }).click();
  await page
    .getByRole("textbox", { name: "New note for topic title" })
    .fill(title);
  await expect(page.locator(".topic-note-create small")).toContainText(
    `Personal Notes/Topics/Vectors/${title}.md`,
  );
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".crumb")).toContainText(
    "Personal Notes/Topics/Vectors",
  );
});

test("persists app-only exercise ticks across reloads", async ({ page }) => {
  await page.goto("/t/python");
  await page.getByText(/^Practice \(\d+\/\d+ complete\)$/).click();
  const exercise = page.getByRole("checkbox", {
    name: /Predict the output for reading 0/,
  });
  const initial = await exercise.isChecked();
  await exercise.click();
  await expect(exercise).toBeChecked({ checked: !initial });
  await page.reload();
  await page.getByText(/^Practice \(\d+\/\d+ complete\)$/).click();
  const reloaded = page.getByRole("checkbox", {
    name: /Predict the output for reading 0/,
  });
  await expect(reloaded).toBeChecked({ checked: !initial });
  await reloaded.click();
  await expect(reloaded).toBeChecked({ checked: initial });
});

test("tracks project steps and suggests status without changing it", async ({
  page,
}) => {
  await page.goto("/practice");
  await expect(page.getByRole("heading", { name: "Practice" })).toBeVisible();
  let project = page
    .locator(".practice-overview-card")
    .filter({ hasText: "Calibrate a Sensor" });
  await expect(project).toBeVisible();
  await expect(
    project.getByRole("progressbar", { name: /step progress/ }),
  ).toHaveAttribute("aria-valuemax", "4");
  await expect(project.getByText("Concepts practiced")).toBeVisible();
  await expect(
    project.getByRole("link", { name: "Linear Regression" }),
  ).toBeVisible();

  await project.getByRole("link", { name: "Open exercises" }).click();
  await page.getByText(/^Practice \(\d+\/\d+ complete\)$/).click();
  const step = page.getByRole("checkbox", {
    name: /Enter the three measured voltages/,
  });
  await expect(step).not.toBeChecked();
  await step.click();
  await expect(step).toBeChecked();

  await page.goto("/practice");
  project = page
    .locator(".practice-overview-card")
    .filter({ hasText: "Calibrate a Sensor" });
  await expect(project).toContainText("Suggested status: in-progress");
  await expect(project).toContainText("not started");

  await project.getByRole("link", { name: "Open exercises" }).click();
  await page.getByText(/^Practice \(\d+\/\d+ complete\)$/).click();
  const checkedStep = page.getByRole("checkbox", {
    name: /Enter the three measured voltages/,
  });
  await expect(checkedStep).toBeChecked();
  await checkedStep.click();
  await page.goto("/practice");
  project = page
    .locator(".practice-overview-card")
    .filter({ hasText: "Calibrate a Sensor" });
  await expect(project).not.toContainText("Suggested status:");
  await expect(project).toContainText("not started");
});

test("links and removes a reference attachment without deleting the vault file", async ({
  page,
}, testInfo) => {
  const vault = await isolatedBrowserVault();
  const filename = `reference-${Date.now()}-${testInfo.project.name}.csv`;
  await writeFile(
    join(vault, "15 - Notebooks", filename),
    `voltage,temperature\n3.3,22.1\n# ${filename}\n`,
  );
  await page.goto("/t/machine-learning");
  const attachments = page.locator(".topic-attachments");
  await attachments.locator("summary").click();
  await attachments.getByRole("button", { name: /15 - Notebooks/ }).click();
  await attachments
    .getByRole("button", { name: new RegExp(`^${filename} ·`) })
    .click();
  await expect(attachments).toContainText("Reference · csv · ok");
  const open = attachments.getByRole("link", { name: `Open ${filename}` });
  await expect(open).toHaveAttribute(
    "href",
    /\/api\/attachments\/.+\/content$/,
  );
  const contentHref = await open.getAttribute("href");
  expect(contentHref).not.toBeNull();
  const content = await page.request.get(contentHref!);
  expect(content.status()).toBe(200);
  expect(await content.text()).toContain("voltage,temperature");
  await attachments
    .getByRole("button", { name: `Preview ${filename}` })
    .click();
  const preview = page.getByRole("dialog", { name: `Preview ${filename}` });
  await expect(preview).toContainText("voltage,temperature");
  await preview.getByRole("button", { name: "Close" }).click();
  await attachments
    .getByRole("button", { name: `Copy ${filename} into Synapse` })
    .click();
  const managedCopy = attachments
    .locator(".topic-attachment-list li")
    .filter({ hasText: "Copy · csv · ok" });
  await expect(managedCopy).toContainText(filename);
  await expect(managedCopy).toContainText("Stored in Synapse application data");
  page.once("dialog", (dialog) => dialog.accept());
  await managedCopy.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(managedCopy).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await attachments.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(attachments.locator(".topic-attachment-list li")).toHaveCount(0);
  const original = await page.request.get(
    "/api/files/15%20-%20Notebooks/calibration.csv",
  );
  expect(original.status()).toBe(200);
});

test("imports a managed copy and keeps the source file intact", async ({
  page,
}) => {
  await page.goto("/t/machine-learning");
  const attachments = page.locator(".topic-attachments");
  await attachments.locator("summary").click();
  await attachments
    .getByLabel("Import a copy into Synapse")
    .setInputFiles(
      "packages/core/test/fixtures/vault/15 - Notebooks/calibration.csv",
    );
  await expect(attachments).toContainText("Copy · csv · ok");
  await expect(attachments).toContainText("Stored in Synapse application data");
  const open = attachments.getByRole("link", { name: "Open calibration.csv" });
  const contentUrl = await open.getAttribute("href");
  expect(contentUrl).not.toBeNull();
  const downloaded = await page.request.get(contentUrl!);
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toContain("voltage,temperature");
  page.once("dialog", (dialog) => dialog.accept());
  await attachments
    .getByRole("button", { name: "Remove calibration.csv" })
    .click();
  await expect(attachments.locator(".topic-attachment-list li")).toHaveCount(0);
  const source = await page.request.get(
    "/api/files/15%20-%20Notebooks/calibration.csv",
  );
  expect(source.status()).toBe(200);
  expect(await source.text()).toContain("voltage,temperature");
});

test("queues, completes, and records a manual topic review", async ({
  page,
}) => {
  await page.goto("/t/linear-regression");
  await page.getByLabel("Optional review date").fill("2026-12-01");
  await page.getByRole("button", { name: "Add to review queue" }).click();
  await expect(page.getByText("In manual review queue")).toBeVisible();
  await page.goto("/");
  const reviews = page.locator(".dash-reviews");
  await expect(
    reviews.getByRole("link", { name: "Linear Regression" }),
  ).toBeVisible();
  await reviews.getByRole("button", { name: "Complete" }).click();
  await expect(reviews).toContainText(
    "No topics are scheduled for manual review.",
  );
  await reviews.getByText("Recent review history").click();
  await expect(reviews).toContainText("Linear Regression");
});

test("finds and confirms a moved attachment reference", async ({
  page,
}, testInfo) => {
  const vault = await isolatedBrowserVault();
  const filename = `relink-${Date.now()}-${testInfo.project.name}.csv`;
  const movedFilename = `relinked-${Date.now()}-${testInfo.project.name}.csv`;
  await writeFile(
    join(vault, "15 - Notebooks", filename),
    `voltage,temperature\n3.3,22.1\n# ${filename}\n`,
  );
  await page.goto("/t/machine-learning");
  const attachments = page.locator(".topic-attachments");
  await attachments.locator("summary").click();
  await attachments.getByRole("button", { name: /15 - Notebooks/ }).click();
  await attachments
    .getByRole("button", { name: new RegExp(`^${filename} ·`) })
    .click();
  const linked = attachments
    .locator(".topic-attachment-list li")
    .filter({ hasText: filename });
  await expect(linked).toContainText("Reference · csv · ok");
  const oldPath = join(vault, "15 - Notebooks", filename);
  const movedPath = join(vault, "15 - Notebooks", movedFilename);
  await rename(oldPath, movedPath);

  await page.reload();
  const relinkPanel = page.locator(".topic-attachments");
  await relinkPanel.locator("summary").click();
  await expect(relinkPanel).toContainText("Reference · csv · missing");
  await relinkPanel.getByRole("button", { name: `Find ${filename}` }).click();
  const candidate = relinkPanel.getByRole("button", {
    name: `Relink to vault/15 - Notebooks/${movedFilename}`,
  });
  await expect(candidate).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await candidate.click();
  await expect(relinkPanel).toContainText("Reference · csv · relinked");
  const open = relinkPanel.getByRole("link", { name: `Open ${filename}` });
  const href = await open.getAttribute("href");
  expect(href).not.toBeNull();
  expect((await page.request.get(href!)).status()).toBe(200);
  page.once("dialog", (dialog) => dialog.accept());
  await relinkPanel.getByRole("button", { name: `Remove ${filename}` }).click();
  await expect(relinkPanel.locator(".topic-attachment-list li")).toHaveCount(0);
});

test("explores the dependency graph and opens a selected curriculum topic", async ({
  page,
}) => {
  await page.goto("/roadmap/graph");
  await expect(
    page.getByRole("heading", { name: "Curriculum graph" }),
  ).toBeVisible();
  const canvas = page.locator(".roadmap-graph-canvas");
  await expect(canvas.locator(".react-flow__node").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(canvas.locator(".react-flow__edge").first()).toHaveAttribute(
    "aria-label",
    /^Edge from /,
  );
  const search = page.getByRole("textbox", { name: "Search graph topics" });
  await search.fill("Linear Regression");
  await expect(
    canvas
      .locator(".react-flow__node")
      .filter({ hasText: "Linear Regression" })
      .first(),
  ).toBeVisible();
  await search.fill("");
  const regression = canvas
    .locator(".react-flow__node")
    .filter({ hasText: "Linear Regression" })
    .first();
  await regression.click();
  await expect(
    page.getByRole("heading", { name: "Linear Regression" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prerequisites" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open topic" }).click();
  await expect(page).toHaveURL(/\/t\/linear-regression$/);
});

test("quick-captures, moves, renames and trashes a personal note", async ({
  page,
}, testInfo) => {
  const token = `note-lifecycle-${Date.now()}-${testInfo.project.name}`;
  await page.goto("/notes");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill(token);
  await page
    .getByRole("combobox", { name: "Scope", exact: true })
    .selectOption("general");
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page.getByRole("heading", { name: token })).toBeVisible();

  await page.getByText("Quick capture", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Quick capture text" })
    .fill(`Capture content for ${token}.`);
  await page.getByRole("button", { name: "Append capture" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown note" });
  await expect(editor).toContainText(`Capture content for ${token}.`);

  await page.getByText("Move note", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Move note scope" })
    .selectOption("topic");
  await page
    .getByRole("combobox", { name: "Move note owner" })
    .selectOption("vectors");
  await expect(
    page.getByText(new RegExp(`Personal Notes/Topics/Vectors/${token}\\.md`)),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm move" }).click();
  await expect(page.getByRole("heading", { name: token })).toBeVisible();
  await expect(page.locator(".crumb")).toContainText(
    "Personal Notes/Topics/Vectors",
  );

  await page.getByText("Rename note", { exact: true }).first().click();
  const renameInput = page.getByRole("textbox", { name: "New note title" });
  await renameInput.fill(`${token} renamed`);
  await expect(renameInput).toHaveValue(`${token} renamed`);
  const renameButton = page.getByRole("button", { name: "Rename note" });
  await expect(renameButton).toBeEnabled();
  await renameButton.click();
  await expect(
    page.getByRole("heading", { name: `${token} renamed` }),
  ).toBeVisible();
  await expect(editor).toContainText(`Capture content for ${token}.`);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Move to vault trash" }).click();
  await expect(
    page.getByRole("heading", { name: "Personal notes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(`${token} renamed`) }),
  ).toHaveCount(0);
});

test("drags the global quick-note button and saves Markdown locally", async ({
  page,
}, testInfo) => {
  const title = `Floating capture ${Date.now()} ${testInfo.project.name}`;
  const sentence = `Quick note body ${title}`;
  await page.goto("/");
  const button = page.getByRole("button", { name: "Quick note" });
  const initial = await button.boundingBox();
  expect(initial).not.toBeNull();
  await page.mouse.move(
    initial!.x + initial!.width / 2,
    initial!.y + initial!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(initial!.x + 110, initial!.y - 70, { steps: 6 });
  await page.mouse.up();
  const moved = await button.boundingBox();
  expect(moved).not.toBeNull();
  expect(moved!.x).toBeGreaterThan(initial!.x + 30);
  expect(moved!.y).toBeLessThan(initial!.y - 30);

  await page.reload();
  const restored = await button.boundingBox();
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeCloseTo(moved!.x, 0);
  expect(restored!.y).toBeCloseTo(moved!.y, 0);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Quick note" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("textbox", { name: "Note" }).fill(sentence);
  await dialog.getByRole("button", { name: "Save quick note" }).click();
  await expect(dialog.getByText("Saved to your vault.")).toBeVisible();
  await dialog.getByRole("link", { name: "Open note" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Markdown note" }),
  ).toContainText(sentence);
});

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
  const editedPanel = page.locator(".dash-edited");
  const editedDate = editedPanel.locator(".recent-notes li > time").first();
  await expect(editedDate).toBeVisible();
  const panelBounds = await editedPanel.boundingBox();
  const dateBounds = await editedDate.boundingBox();
  expect(panelBounds).not.toBeNull();
  expect(dateBounds).not.toBeNull();
  expect(dateBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
  expect(dateBounds!.x + dateBounds!.width).toBeLessThanOrEqual(
    panelBounds!.x + panelBounds!.width - 4,
  );
  expect(dateBounds!.y).toBeGreaterThanOrEqual(panelBounds!.y);
  expect(dateBounds!.y + dateBounds!.height).toBeLessThanOrEqual(
    panelBounds!.y + panelBounds!.height - 4,
  );
  await page.getByText("Domain, module & project rollups").click();
  await expect(
    page.getByRole("heading", { name: "By domain", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Projects by status" }),
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
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Focus by domain" }),
  ).toBeVisible();
  await expect(page.locator(".focus-rollup li").first()).toBeVisible();
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
  const properties = page.locator(".note-properties").first();
  await expect(properties).toBeVisible();
  await expect(properties).toContainText("machine-learning");
  await expect(
    properties.getByRole("link", { name: "Dot Products" }),
  ).toBeVisible();
  await page
    .getByText(/^Properties \(\d+\)$/)
    .first()
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^Prerequisites$/ })
    .first()
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
