import { homedir } from "node:os";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const projectDir = fileURLToPath(new URL("../../../", import.meta.url));
const rootPath = z.string().min(1);
export const configSchema = z
  .object({
    vaultPath: rootPath.default(".local/vault"),
    dataDir: rootPath.default(".local/state"),
    allowVaultWrites: z.boolean().default(false),
    server: z
      .object({
        host: z
          .enum(["127.0.0.1", "::1"], {
            error: "Synapse requires a loopback address (127.0.0.1 or ::1)",
          })
          .default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(4317),
      })
      .prefault({}),
    learningPathNote: rootPath.default("00 - Start Here/Learning Path.md"),
    courseHomeNote: rootPath.default(
      "01 - Foundations/Python Course/Python Course Home.md",
    ),
    personalNotes: z
      .object({ root: rootPath.default("Personal Notes") })
      .prefault({}),
    attachments: z
      .object({
        maxUploadBytes: z.number().positive().default(2147483648),
        extraRoots: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
              path: rootPath,
            }),
          )
          .default([]),
      })
      .prefault({}),
    exerciseSections: z
      .array(z.string())
      .default([
        "Exercises",
        "Steps",
        "Milestones",
        "Stretch goals",
        "Stretch",
      ]),
    session: z
      .object({
        idleMinutes: z.number().positive().default(15),
        heartbeatLostSeconds: z.number().positive().default(120),
        maxHours: z.number().positive().max(4).default(4),
      })
      .prefault({}),
    timezone: z
      .string()
      .refine((s) => {
        try {
          if (s !== "system") new Intl.DateTimeFormat("en", { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }, "Invalid IANA timezone")
      .default("system"),
    network: z
      .object({
        linkPreviews: z.boolean().default(false),
        linkChecker: z.boolean().default(false),
      })
      .prefault({}),
    ignore: z.array(z.string()).default([]),
  })
  .strict();
function expand(p: string) {
  return resolve(projectDir, p.replace(/^~(?=\/|$)/, homedir()));
}
function canonical(p: string): string {
  return existsSync(p)
    ? realpathSync(p)
    : join(canonical(dirname(p)), p.slice(dirname(p).length + 1));
}
export function within(parent: string, child: string) {
  const r = relative(parent, child);
  return !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep);
}
export function configFrom(input: unknown) {
  const c = configSchema.parse(input);
  const rootIds = c.attachments.extraRoots.map((root) => root.id);
  if (
    new Set(rootIds).size !== rootIds.length ||
    rootIds.some((id) => id === "vault" || id === "managed")
  )
    throw Error(
      "Attachment root ids must be unique and cannot use reserved ids",
    );
  c.vaultPath = canonical(expand(c.vaultPath));
  c.dataDir = canonical(expand(c.dataDir));
  c.attachments.extraRoots = c.attachments.extraRoots.map((root) => ({
    ...root,
    path: canonical(expand(root.path)),
  }));
  if (within(c.vaultPath, c.dataDir) || within(c.dataDir, c.vaultPath))
    throw Error("Vault and application data must be separate directories");
  return c;
}
export type Config = ReturnType<typeof configFrom>;
function configFile(path: string) {
  try {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw Error("Invalid configuration in " + path, { cause: e });
  }
}
function merge(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
) {
  const result = { ...first, ...second };
  for (const key of Object.keys(second)) {
    const a = first[key],
      b = second[key];
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    )
      result[key] = { ...a, ...b };
  }
  return result;
}
export function loadConfig() {
  if (process.env.SYNAPSE_CONFIG)
    return configFrom(
      JSON.parse(readFileSync(process.env.SYNAPSE_CONFIG, "utf8")),
    );
  return configFrom(
    merge(
      configFile(
        join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          "synapse/config.json",
        ),
      ),
      configFile(join(projectDir, "synapse.config.json")),
    ),
  );
}
