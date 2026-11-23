import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  addFrontmatter,
  replaceRange,
  setFrontmatterList,
} from "@synapse/core/patch";
import { parseSource, strings } from "@synapse/core";
import type { Context } from "../app";
import { transaction } from "../db/transaction";
import { hash } from "../vault/scanner";
import {
  WriteError,
  type WriteCoordinator,
  type WriteOp,
} from "../vault/writes";

type Proposal = {
  path: string;
  targetPath?: string;
  issueId: string;
  op: WriteOp;
  evidence: string;
  before: string;
  after: string;
  baseHash: string;
};
const kindSchema = z.enum([
  "health-fix",
  "python-course-migration",
  "notes-migration",
]);
type Kind = z.infer<typeof kindSchema>;

function previewHash(item: Pick<Proposal, "targetPath" | "after">) {
  return hash(
    item.targetPath
      ? JSON.stringify([item.targetPath, item.after])
      : item.after,
  );
}
function previewResponse({ op: _, ...item }: Proposal) {
  return { ...item, afterHash: previewHash(item) };
}
function proposals({ work, config }: Context, kind: Kind): Proposal[] {
  const files = new Map(work.scan.files.map((file) => [file.path, file]));
  const result: Proposal[] = [];
  if (kind === "notes-migration") {
    for (const node of work.index.nodes) {
      if (
        node.kind !== "note" ||
        !node.path.startsWith("99 - Inbox/") ||
        node.path.startsWith(config.personalNotes.root + "/")
      )
        continue;
      const file = files.get(node.path);
      if (!file) continue;
      const related =
        node.about.length === 1
          ? work.index.nodes.find((topic) => topic.slug === node.about[0])
          : undefined;
      const folder = related
        ? (["project", "course-project"].includes(related.kind)
            ? "Projects/"
            : "Topics/") + related.title
        : "General";
      const targetPath =
        config.personalNotes.root +
        "/" +
        folder +
        "/" +
        file.path.split("/").at(-1);
      if (files.has(targetPath)) continue;
      result.push({
        path: file.path,
        targetPath,
        issueId: hash("notes-migration:" + file.path),
        op: { type: "moveFile", to: targetPath },
        evidence: related
          ? "The legacy note is associated with " +
            related.title +
            ". Its filename and bytes are preserved."
          : "No single topic association was found. The original filename and contents will be preserved in General.",
        before: file.text,
        after: file.text,
        baseHash: file.hash,
      });
    }
    return result;
  }
  for (const issue of work.index.issues) {
    const file = files.get(issue.path);
    const node = work.index.nodes.find((node) => node.path === issue.path);
    if (!file || !node) continue;
    let candidate: Pick<Proposal, "op" | "evidence" | "after"> | undefined;
    try {
      if (
        kind === "python-course-migration" &&
        issue.code === "frontmatter.missing" &&
        node.path.includes("/Python Course/") &&
        ["course", "lesson", "course-project", "reference"].includes(node.kind)
      ) {
        const type =
          node.kind === "lesson"
            ? "lesson"
            : node.kind === "course-project"
              ? "project"
              : "moc";
        const checked =
          node.status.source === "course-checkbox" &&
          node.status.value === "checked";
        const status =
          type === "lesson"
            ? checked
              ? "understood"
              : "unread"
            : type === "project" && checked
              ? "completed"
              : "not-started";
        const fields = { type, domain: "programming", status };
        const basis =
          node.status.source === "course-checkbox"
            ? "the matching Python Course Home checkbox"
            : "the initial vocabulary value for the identified file type";
        candidate = {
          op: { type: "addFrontmatter", fields },
          evidence:
            "Type follows the course file structure. Domain follows the Python Course. Status follows " +
            basis +
            ".",
          after: addFrontmatter(file.text, fields),
        };
      } else if (kind === "health-fix" && issue.code === "link.folder") {
        const target = issue.message.slice("Folder link: ".length);
        const link = node.links.find(
          (link) => link.target === target && link.line === issue.line,
        );
        const stage = work.index.learningPath.stages.find(
          (stage) => Number(target.split(" - ")[0]) === stage.number,
        );
        const entry =
          stage?.entryNotes.length === 1 ? stage.entryNotes[0] : undefined;
        if (
          !link ||
          !entry ||
          !work.index.nodes.some((note) => note.title === entry)
        )
          continue;
        const op = {
          type: "replaceRange" as const,
          start: link.offset,
          end: link.offset + link.raw.length,
          expectText: link.raw,
          newText: "[[" + entry + "|" + link.label + "]]",
        };
        candidate = {
          op,
          evidence:
            "The Learning Path identifies " +
            entry +
            " as this stage's entry note.",
          after: replaceRange(
            file.text,
            op.start,
            op.end,
            op.expectText,
            op.newText,
          ),
        };
      } else if (
        kind === "health-fix" &&
        issue.code === "prereq.bodyOnly" &&
        node.fm.present &&
        !node.fm.error
      ) {
        const prior = strings(node.fm.meta.prerequisites);
        const declared = new Set(prior.map((value) => value.toLowerCase()));
        const missing = node.links
          .filter(
            (link) =>
              link.section.toLowerCase() === "prerequisites" &&
              link.slug &&
              !declared.has(link.target.toLowerCase()),
          )
          .map((link) => link.target);
        const items = [...new Set([...prior, ...missing])];
        if (items.length === prior.length) continue;
        candidate = {
          op: {
            type: "setList",
            key: "prerequisites",
            items,
            expect: node.fm.meta.prerequisites ?? null,
          },
          evidence:
            "These links already appear in the file's Prerequisites section.",
          after: setFrontmatterList(file.text, "prerequisites", items),
        };
      }
      if (!candidate || candidate.after === file.text) continue;
      const parsed = parseSource({ ...file, text: candidate.after });
      if (parsed.fm.error && !node.fm.error) continue;
      result.push({
        ...candidate,
        path: file.path,
        issueId: issue.id,
        before: file.text,
        baseHash: file.hash,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "PatchError") throw error;
    }
  }
  return result;
}

const courseEdits = z
  .object({
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    importance: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();
type CourseEdits = z.infer<typeof courseEdits>;
function withCourseEdits(item: Proposal, edits: CourseEdits): Proposal {
  if (item.op.type !== "addFrontmatter")
    throw new WriteError(
      422,
      "VALIDATION",
      "These fields are available only for course metadata.",
    );
  const fields = { ...item.op.fields };
  if (edits.difficulty) fields.difficulty = edits.difficulty;
  if (edits.importance) fields.importance = edits.importance;
  const supplied = [
    edits.difficulty && "difficulty " + edits.difficulty,
    edits.importance && "importance " + edits.importance,
  ].filter(Boolean);
  return {
    ...item,
    op: { type: "addFrontmatter", fields },
    after: addFrontmatter(item.before, fields),
    evidence:
      item.evidence +
      (supplied.length ? " Entered by you: " + supplied.join(", ") + "." : ""),
  };
}

const approvedSchema = z
  .object({
    kind: kindSchema,
    items: z
      .array(
        z
          .object({
            issueId: z.string(),
            baseHash: z.string().regex(/^[a-f0-9]{64}$/),
            afterHash: z.string().regex(/^[a-f0-9]{64}$/),
            edits: courseEdits.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    confirm: z.literal(true),
  })
  .strict();

export function registerChangesets(ctx: Context, writer: WriteCoordinator) {
  const { app, state, config } = ctx;
  const { db } = state;
  let busy = false;
  const history = () =>
    db
      .prepare(
        `SELECT i.id,i.path,i.target_path,i.state,i.error,s.kind,s.created_at FROM change_item i
 JOIN change_set s ON s.id=i.change_set_id ORDER BY s.created_at DESC,i.path`,
      )
      .all();

  function reconcile() {
    db.exec(`UPDATE change_item AS i SET state='applied',
     after_hash=(SELECT new_hash FROM write_journal WHERE change_item_id=i.id AND state='committed' ORDER BY created_at DESC LIMIT 1),
     backup_path=(SELECT backup_path FROM write_journal WHERE change_item_id=i.id AND state='committed' ORDER BY created_at DESC LIMIT 1)
     WHERE i.state='proposed' AND EXISTS(SELECT 1 FROM write_journal WHERE change_item_id=i.id AND state='committed');
   UPDATE change_item AS i SET state='reverted'
     WHERE i.state='applied' AND EXISTS(SELECT 1 FROM write_journal WHERE change_item_id=i.id AND state='committed' AND base_hash=i.after_hash AND new_hash=i.base_hash AND (i.target_path IS NULL OR (path=i.target_path AND target_path=i.path)));
   UPDATE change_set AS s SET state=CASE
     WHEN NOT EXISTS(SELECT 1 FROM change_item WHERE change_set_id=s.id AND state<>'reverted') THEN 'reverted'
     WHEN NOT EXISTS(SELECT 1 FROM change_item WHERE change_set_id=s.id AND state<>'applied') THEN 'applied'
     ELSE 'partially-applied' END WHERE s.state<>'discarded';`);
  }
  reconcile();
  app.get("/api/vault-health/proposals", (request) => {
    const { kind } = z.object({ kind: kindSchema }).parse(request.query);
    return proposals(ctx, kind).map(previewResponse);
  });
  app.get<{ Params: { id: string } }>(
    "/api/vault-health/course-preview/:id",
    (request) => {
      const edits = courseEdits.parse(request.query);
      const original = proposals(ctx, "python-course-migration").find(
        (item) => item.issueId === request.params.id,
      );
      if (!original)
        throw new WriteError(
          404,
          "NOT_FOUND",
          "This course proposal is no longer available.",
        );
      return { ...previewResponse(withCourseEdits(original, edits)), edits };
    },
  );
  app.get("/api/changesets", history);
  app.post("/api/changesets/apply", async (request) => {
    if (!config.allowVaultWrites)
      throw new WriteError(
        403,
        "NOT_ALLOWED",
        "This vault is open in read-only mode.",
      );
    if (busy)
      throw new WriteError(409, "CONFLICT", "Another change set is running.");
    const input = approvedSchema.parse(request.body);
    await ctx.work.refresh();
    if (busy)
      throw new WriteError(409, "CONFLICT", "Another change set is running.");
    const current = new Map(
      proposals(ctx, input.kind).map((item) => [item.issueId, item]),
    );
    const selected = input.items.map((item) => {
      const original = current.get(item.issueId);
      if (item.edits && input.kind !== "python-course-migration")
        throw new WriteError(
          422,
          "VALIDATION",
          "This workflow does not accept course fields.",
        );
      const proposal =
        original && item.edits
          ? withCourseEdits(original, item.edits)
          : original;
      if (
        !proposal ||
        proposal.baseHash !== item.baseHash ||
        previewHash(proposal) !== item.afterHash
      )
        throw new WriteError(
          409,
          "CONFLICT",
          "The file or proposal changed. Review the latest preview.",
        );
      return proposal;
    });
    if (new Set(selected.map((item) => item.path)).size !== selected.length)
      throw new WriteError(
        422,
        "VALIDATION",
        "Select one proposal per file for this batch.",
      );
    busy = true;
    try {
      const batch = randomUUID();
      const items = transaction(db, () => {
        db.prepare("INSERT INTO change_set VALUES(?,?,?,?, 'draft')").run(
          batch,
          input.kind,
          input.kind === "health-fix"
            ? "Vault repairs"
            : input.kind === "notes-migration"
              ? "Legacy note migration"
              : "Python Course migration",
          Date.now(),
        );
        const insert = db.prepare(
          "INSERT INTO change_item(id,change_set_id,issue_id,path,target_path,op_json,evidence_json,base_hash,approved,state) VALUES(?,?,?,?,?,?,?,?,1,'proposed')",
        );
        return selected.map((item) => {
          const id = randomUUID();
          insert.run(
            id,
            batch,
            item.issueId,
            item.path,
            item.targetPath ?? null,
            JSON.stringify(item.op),
            JSON.stringify(item.evidence),
            item.baseHash,
          );
          return { ...item, id };
        });
      });
      for (const item of items) {
        try {
          const written = await writer.write({
            trigger: "changeset",
            changeItemId: item.id,
            path: item.path,
            baseHash: item.baseHash,
            op: item.op,
          });
          db.prepare(
            "UPDATE change_item SET state='applied',after_hash=?,backup_path=?,applied_at=? WHERE id=?",
          ).run(written.hash, written.backupPath, Date.now(), item.id);
          const indexed = ctx.work.scan.files.find(
            (file) => file.path === (item.targetPath ?? item.path),
          );
          const stillHasIssue = ctx.work.index.issues.some(
            (issue) => issue.id === item.issueId,
          );
          if (indexed?.hash !== written.hash) {
            db.prepare("UPDATE change_item SET error=? WHERE id=?").run(
              "The file changed again after apply. Review the current contents before undoing.",
              item.id,
            );
          } else if (written.hash !== hash(item.after) || stillHasIssue) {
            try {
              if (!written.id) throw new Error("No write journal entry");
              await writer.write({
                trigger: "changeset",
                changeItemId: item.id,
                path: item.targetPath ?? item.path,
                baseHash: written.hash,
                op: item.targetPath
                  ? { type: "moveFile", to: item.path }
                  : {
                      type: "replaceFile",
                      text: writer.version(item.path, written.id),
                    },
              });
              db.prepare(
                "UPDATE change_item SET state='failed',error=? WHERE id=?",
              ).run(
                "The result failed validation. The original bytes were restored.",
                item.id,
              );
            } catch {
              db.prepare("UPDATE change_item SET error=? WHERE id=?").run(
                "The result failed validation and could not be restored automatically. Review the backup and current contents.",
                item.id,
              );
            }
          }
        } catch (error) {
          reconcile();
          db.prepare(
            "UPDATE change_item SET state=?,error=? WHERE id=? AND state='proposed'",
          ).run(
            error instanceof WriteError && error.statusCode === 409
              ? "skipped-conflict"
              : "failed",
            error instanceof WriteError
              ? error.message
              : "The write failed. Check Vault Health.",
            item.id,
          );
        }
      }
      reconcile();
      return history();
    } finally {
      busy = false;
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/changesets/items/:id/revert",
    async (request) => {
      z.object({ confirm: z.literal(true) })
        .strict()
        .parse(request.body);
      if (!config.allowVaultWrites)
        throw new WriteError(
          403,
          "NOT_ALLOWED",
          "This vault is open in read-only mode.",
        );
      if (busy)
        throw new WriteError(409, "CONFLICT", "Another change set is running.");
      const item = db
        .prepare("SELECT * FROM change_item WHERE id=? AND state='applied'")
        .get(request.params.id);
      if (!item)
        throw new WriteError(
          404,
          "NOT_FOUND",
          "There is no applied item to revert.",
        );
      const journal = db
        .prepare(
          "SELECT id FROM write_journal WHERE change_item_id=? AND base_hash=? AND new_hash=? AND path=? AND state='committed' ORDER BY created_at LIMIT 1",
        )
        .get(request.params.id, item.base_hash!, item.after_hash!, item.path!);
      if (!journal)
        throw new WriteError(
          404,
          "NOT_FOUND",
          "The original version is unavailable.",
        );
      busy = true;
      try {
        const path = String(item.path);
        await writer.write({
          trigger: "changeset",
          changeItemId: request.params.id,
          path: item.target_path ? String(item.target_path) : path,
          baseHash: String(item.after_hash),
          op: item.target_path
            ? { type: "moveFile", to: path }
            : {
                type: "replaceFile",
                text: writer.version(path, String(journal.id)),
              },
        });
        db.prepare(
          "UPDATE change_item SET state='reverted',reverted_at=? WHERE id=?",
        ).run(Date.now(), request.params.id);
        reconcile();
        return history();
      } finally {
        busy = false;
      }
    },
  );
}
