import chokidar from "chokidar";
import { buildIndex, parseSource } from "@synapse/core";
import type { VaultIndex } from "@synapse/core";
import { relative } from "node:path";
import { EventEmitter } from "node:events";
import { isIgnored, scanVault } from "./scanner";
import type { Config } from "../config";
import type { ServerResponse } from "node:http";
export class Workspace {
  index: VaultIndex = buildIndex([]);
  scan: Awaited<ReturnType<typeof scanVault>> = {
    files: [],
    library: [],
    unsafe: [],
    conflicts: [],
  };
  cache = new Map<string, ReturnType<typeof parseSource>>();
  version = 0;
  unavailable = "";
  changes = new EventEmitter();
  private watcher?: ReturnType<typeof chokidar.watch>;
  private timer: NodeJS.Timeout | undefined;
  private queued: Promise<void> = Promise.resolve();
  private events: { id: number; name: string; data: unknown }[] = [];
  private seq = 0;
  private clients = new Set<ServerResponse>();
  constructor(
    readonly config: Config,
    readonly reconcile: (
      index: VaultIndex,
      files: Workspace["scan"]["files"],
      origin: "app" | "external" | "changeset",
    ) => unknown = () => {},
  ) {}
  refresh(origin: "external" | "app" | "changeset" = "external") {
    const run = async () => {
      try {
        const next = await scanVault(this.config.vaultPath, this.config.ignore);
        const index = buildIndex(
          next.files,
          {
            learningPathNote: this.config.learningPathNote,
            courseHomeNote: this.config.courseHomeNote,
            exerciseSections: this.config.exerciseSections,
            personalRoot: this.config.personalNotes.root,
            library: next.library.map((f) => f.path),
            unsafe: next.unsafe,
            conflicts: next.conflicts,
          },
          this.cache,
        );
        this.reconcile(index, next.files, origin);
        const previous = new Map(this.scan.files.map((f) => [f.path, f.hash]));
        const changed = next.files
          .filter((f) => previous.get(f.path) !== f.hash)
          .map((f) => f.path);
        const current = new Set(next.files.map((f) => f.path));
        changed.push(
          ...this.scan.files
            .filter((f) => !current.has(f.path))
            .map((f) => f.path),
        );
        const wasUnavailable = this.unavailable;
        const ancillary =
          JSON.stringify([
            this.scan.library,
            this.scan.conflicts,
            this.scan.unsafe,
          ]) !== JSON.stringify([next.library, next.conflicts, next.unsafe]);
        this.scan = next;
        this.index = index;
        this.unavailable = "";
        if (this.cache.size > 2 * next.files.length + 8) this.cache.clear();
        if (changed.length || !this.version || wasUnavailable || ancillary)
          this.emit("index.changed", {
            version: ++this.version,
            changed,
            origin,
          });
      } catch (e) {
        this.unavailable = "The vault could not be read";
        this.emit("vault.unavailable", { message: this.unavailable });
        throw e;
      }
    };
    const result = this.queued.then(run);
    this.queued = result.catch(() => {});
    return result;
  }
  async start() {
    this.watcher = chokidar.watch(this.config.vaultPath, {
      ignoreInitial: true,
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: (p) =>
        relative(this.config.vaultPath, p).split("/").some(isIgnored),
    });
    this.watcher.on("all", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.refresh().catch(() => {});
      }, 150);
    });
    this.watcher.on("error", () => {
      this.unavailable = "The file watcher is unavailable";
      this.emit("vault.unavailable", { message: this.unavailable });
    });
    await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
    await this.refresh().catch(() => {});
  }
  emit(name: string, data: unknown) {
    const event = { id: ++this.seq, name, data };
    this.events.push(event);
    if (this.events.length > 128) this.events.shift();
    for (const client of this.clients) this.send(client, event);
    this.changes.emit(name, data);
  }
  private send(
    res: ServerResponse,
    e: { id: number; name: string; data: unknown },
  ) {
    res.write(
      "id: " +
        e.id +
        "\nevent: " +
        e.name +
        "\ndata: " +
        JSON.stringify(e.data) +
        "\n\n",
    );
  }
  subscribe(res: ServerResponse, last: number) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    if (
      last > 0 &&
      this.events[0] &&
      last >= this.events[0].id - 1 &&
      last <= this.seq
    ) {
      for (const e of this.events) if (e.id > last) this.send(res, e);
    } else
      this.send(res, {
        id: this.seq,
        name: "index.changed",
        data: { version: this.version },
      });
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    res.on("close", () => {
      this.clients.delete(res);
      clearInterval(timer);
    });
  }
  async close() {
    clearTimeout(this.timer);
    await this.watcher?.close();
    await this.queued;
    for (const c of this.clients) c.end();
  }
}
