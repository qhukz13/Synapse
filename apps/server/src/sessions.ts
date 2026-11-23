import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config";
import { Temporal } from "@js-temporal/polyfill";
import { dailyStudyTime, streakSummary } from "@synapse/core/sessions";
import { transaction } from "./db/transaction";

type Session = {
  id: string;
  nid: string | null;
  state: string;
  started_at: number;
  ended_at: number | null;
  last_heartbeat_at: number | null;
  end_reason: string | null;
  note: string | null;
};
export class SessionService {
  #lastInput = new Map<string, number>();
  #timer: ReturnType<typeof setInterval>;
  private zone: string;
  constructor(
    private db: DatabaseSync,
    private config: Config,
    zone?: string,
    private now = Date.now,
  ) {
    const capturedZone =
      config.timezone === "system"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : config.timezone;
    if (config.timezone !== "system")
      db.prepare(
        "INSERT INTO kv(key,value) VALUES('settings.timezone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(capturedZone);
    else
      db.prepare(
        "INSERT OR IGNORE INTO kv(key,value) VALUES('settings.timezone',?)",
      ).run(capturedZone);
    this.zone =
      zone ??
      String(
        db.prepare("SELECT value FROM kv WHERE key='settings.timezone'").get()
          ?.value ?? capturedZone,
      );
    this.recover();
    this.#timer = setInterval(() => this.tick(), 10_000);
    this.#timer.unref();
  }
  close() {
    clearInterval(this.#timer);
  }
  recover() {
    const rows = this.db
      .prepare(
        "SELECT * FROM study_session WHERE state IN ('running','paused')",
      )
      .all() as unknown as Session[];
    const now = this.now();
    for (const s of rows) {
      if (s.state === "running") {
        const end = Math.max(s.started_at, s.last_heartbeat_at ?? s.started_at);
        this.closeSegment(s.id, end, "server-restart");
        this.db
          .prepare(
            "UPDATE study_session SET state='paused',end_reason='server-restart' WHERE id=?",
          )
          .run(s.id);
        this.audit(s.id, now, "server-restart", s, {
          ...s,
          state: "paused",
          end_reason: "server-restart",
        });
      }
    }
  }
  private audit(
    id: string,
    at: number,
    action: string,
    before: unknown,
    after: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO session_audit(session_id,at,action,before_json,after_json) VALUES(?,?,?,?,?)",
      )
      .run(id, at, action, JSON.stringify(before), JSON.stringify(after));
  }
  private closeSegment(id: string, end: number, reason: string) {
    const segment = this.db
      .prepare(
        "SELECT id,started_at FROM session_segment WHERE session_id=? AND ended_at IS NULL",
      )
      .get(id) as { id: number; started_at: number } | undefined;
    if (segment)
      this.db
        .prepare(
          "UPDATE session_segment SET ended_at=?,close_reason=? WHERE id=?",
        )
        .run(Math.max(segment.started_at, end), reason, segment.id);
  }
  private get(id?: string) {
    const row = (
      id
        ? this.db.prepare("SELECT * FROM study_session WHERE id=?").get(id)
        : this.db
            .prepare(
              "SELECT * FROM study_session WHERE state IN ('running','paused')",
            )
            .get()
    ) as Session | undefined;
    return row ?? null;
  }
  current() {
    const s = this.get();
    return s
      ? {
          ...s,
          segments: this.db
            .prepare(
              "SELECT * FROM session_segment WHERE session_id=? ORDER BY id",
            )
            .all(s.id),
          segment:
            this.db
              .prepare(
                "SELECT * FROM session_segment WHERE session_id=? ORDER BY id DESC LIMIT 1",
              )
              .get(s.id) ?? null,
        }
      : null;
  }
  list() {
    const sessions = this.db
      .prepare(
        "SELECT ss.*,ni.slug AS topic_slug,ni.title AS topic_title FROM study_session ss LEFT JOIN node_identity ni ON ni.nid=ss.nid ORDER BY ss.started_at DESC LIMIT 100",
      )
      .all() as unknown as Session[];
    return sessions.map((s) => {
      const segments = this.db
        .prepare("SELECT * FROM session_segment WHERE session_id=? ORDER BY id")
        .all(s.id) as {
        id: number;
        started_at: number;
        ended_at: number | null;
        close_reason: string | null;
      }[];
      const durationMs = segments.reduce(
        (total, segment) =>
          total +
          Math.max(
            0,
            (segment.ended_at ??
              (s.state === "running" ? this.now() : segment.started_at)) -
              segment.started_at,
          ),
        0,
      );
      return { ...s, segments, durationMs };
    });
  }
  start(nid: string | null) {
    const at = this.now();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.get())
        throw Object.assign(
          Error("Finish or pause the current study session first."),
          { statusCode: 409 },
        );
      this.db
        .prepare(
          "INSERT INTO study_session(id,nid,state,started_at,last_heartbeat_at) VALUES(?,?,'running',?,?)",
        )
        .run(id, nid, at, at);
      this.db
        .prepare(
          "INSERT INTO session_segment(session_id,started_at) VALUES(?,?)",
        )
        .run(id, at);
      this.audit(id, at, "start", null, { nid, state: "running", at });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.#lastInput.set(id, at);
    return this.current();
  }
  action(
    id: string,
    action: "pause" | "resume" | "stop" | "discard",
    note?: string,
  ) {
    const s = this.get(id);
    if (!s)
      throw Object.assign(Error("Study session not found."), {
        statusCode: 404,
      });
    const at = this.now();
    const before = s;
    if (action === "pause" && s.state === "running") {
      this.closeSegment(id, at, "pause");
      this.db
        .prepare(
          "UPDATE study_session SET state='paused',last_heartbeat_at=? WHERE id=?",
        )
        .run(at, id);
    } else if (action === "resume" && s.state === "paused") {
      this.db
        .prepare(
          "UPDATE study_session SET state='running',last_heartbeat_at=? WHERE id=?",
        )
        .run(at, id);
      this.db
        .prepare(
          "INSERT INTO session_segment(session_id,started_at) VALUES(?,?)",
        )
        .run(id, at);
      this.#lastInput.set(id, at);
    } else if (action === "stop" && ["running", "paused"].includes(s.state)) {
      this.closeSegment(id, at, "stop");
      this.db
        .prepare(
          "UPDATE study_session SET state='ended',ended_at=?,end_reason='user',note=COALESCE(?,note) WHERE id=?",
        )
        .run(at, note ?? null, id);
    } else if (
      action === "discard" &&
      ["running", "paused", "ended"].includes(s.state)
    ) {
      if (s.state === "running") this.closeSegment(id, at, "stop");
      this.db
        .prepare(
          "UPDATE study_session SET state='discarded',ended_at=COALESCE(ended_at,?),note=COALESCE(?,note) WHERE id=?",
        )
        .run(at, note ?? null, id);
    } else
      throw Object.assign(Error(`Cannot ${action} a ${s.state} session.`), {
        statusCode: 409,
      });
    this.audit(id, at, action, before, this.get(id));
    return this.get(id);
  }
  trimSegment(
    id: string,
    segmentId: number,
    patch: {
      startAt?: number | undefined;
      endAt?: number | undefined;
      delete?: boolean | undefined;
      confirm?: boolean | undefined;
    },
  ) {
    const session = this.get(id);
    if (!session)
      throw Object.assign(Error("Study session not found."), {
        statusCode: 404,
      });
    if (session.state === "discarded")
      throw Object.assign(Error("Discarded sessions cannot be corrected."), {
        statusCode: 409,
      });
    const segment = this.db
      .prepare("SELECT * FROM session_segment WHERE id=? AND session_id=?")
      .get(segmentId, id) as
      | {
          id: number;
          started_at: number;
          ended_at: number | null;
          close_reason: string | null;
        }
      | undefined;
    if (!segment)
      throw Object.assign(Error("Study segment not found."), {
        statusCode: 404,
      });
    if (segment.ended_at === null)
      throw Object.assign(
        Error("Pause or finish the session before correcting this segment."),
        { statusCode: 409 },
      );
    const at = this.now();
    if (patch.delete) {
      if (!patch.confirm)
        throw Object.assign(
          Error("Confirm removal of this recorded segment."),
          { statusCode: 422 },
        );
      transaction(this.db, () => {
        this.db
          .prepare("DELETE FROM session_segment WHERE id=?")
          .run(segmentId);
        this.audit(id, at, "trim", segment, { deleted: true, segmentId });
      });
      return { sessionId: id, segmentId, deleted: true };
    }
    const startAt = patch.startAt ?? segment.started_at;
    const endAt = patch.endAt ?? segment.ended_at;
    if (
      !Number.isSafeInteger(startAt) ||
      !Number.isSafeInteger(endAt) ||
      startAt < segment.started_at ||
      endAt > segment.ended_at ||
      startAt >= endAt
    )
      throw Object.assign(
        Error(
          "A correction can only shorten a segment and must leave positive recorded time.",
        ),
        { statusCode: 422 },
      );
    if (startAt === segment.started_at && endAt === segment.ended_at)
      throw Object.assign(Error("Choose a shorter start or end time."), {
        statusCode: 422,
      });
    const after = { ...segment, started_at: startAt, ended_at: endAt };
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE session_segment SET started_at=?,ended_at=? WHERE id=?",
        )
        .run(startAt, endAt, segmentId);
      this.audit(id, at, "trim", segment, after);
    });
    return after;
  }
  heartbeat(id: string, lastInputAt: number) {
    const s = this.get(id);
    if (!s || s.state !== "running")
      throw Object.assign(Error("No running study session."), {
        statusCode: 409,
      });
    const at = this.now();
    if (
      s.last_heartbeat_at &&
      at - s.last_heartbeat_at > this.config.session.heartbeatLostSeconds * 1000
    ) {
      const end = Math.max(s.started_at, s.last_heartbeat_at);
      this.closeSegment(id, end, "heartbeat-lost");
      this.db
        .prepare(
          "UPDATE study_session SET state='paused',end_reason='heartbeat-lost' WHERE id=?",
        )
        .run(id);
      this.audit(id, at, "heartbeat-lost", s, { ...s, state: "paused" });
      return this.get(id);
    }
    const safeInput = Math.max(s.started_at, Math.min(at, lastInputAt));
    this.db
      .prepare("UPDATE study_session SET last_heartbeat_at=? WHERE id=?")
      .run(at, id);
    this.#lastInput.set(
      id,
      Math.max(this.#lastInput.get(id) ?? safeInput, safeInput),
    );
    this.tick();
    return this.get(id);
  }
  restoreIdle(id: string, segmentId: number) {
    const s = this.get(id);
    const seg = this.db
      .prepare("SELECT * FROM session_segment WHERE id=? AND session_id=?")
      .get(segmentId, id) as
      | {
          id: number;
          started_at: number;
          ended_at: number;
          close_reason: string;
        }
      | undefined;
    if (
      !s ||
      s.state !== "paused" ||
      !seg ||
      seg.close_reason !== "idle" ||
      seg.ended_at >= (s.last_heartbeat_at ?? 0)
    )
      throw Object.assign(
        Error("This idle interval can no longer be restored."),
        { statusCode: 409 },
      );
    this.db
      .prepare("UPDATE session_segment SET ended_at=? WHERE id=?")
      .run(s.last_heartbeat_at, segmentId);
    this.audit(id, this.now(), "restore-idle", seg, {
      ...seg,
      ended_at: s.last_heartbeat_at,
    });
    return this.get(id);
  }
  tick() {
    const s = this.get();
    if (!s || s.state !== "running") return;
    const at = this.now();
    const active = this.db
      .prepare(
        "SELECT COALESCE(SUM(ended_at-started_at),0) AS total FROM session_segment WHERE session_id=? AND ended_at IS NOT NULL",
      )
      .get(s.id) as { total: number };
    const open = this.db
      .prepare(
        "SELECT started_at FROM session_segment WHERE session_id=? AND ended_at IS NULL",
      )
      .get(s.id) as { started_at: number } | undefined;
    const max = open
      ? open.started_at +
        Math.max(0, this.config.session.maxHours * 60 * 60_000 - active.total)
      : at;
    if (at >= max) {
      this.closeSegment(s.id, max, "max-duration");
      this.db
        .prepare(
          "UPDATE study_session SET state='ended',ended_at=?,end_reason='max-duration' WHERE id=?",
        )
        .run(max, s.id);
      this.audit(s.id, at, "max-duration", s, {
        ...s,
        state: "ended",
        ended_at: max,
      });
      return;
    }
    if (
      !s.last_heartbeat_at ||
      at - s.last_heartbeat_at > this.config.session.heartbeatLostSeconds * 1000
    ) {
      const end = Math.max(s.started_at, s.last_heartbeat_at ?? s.started_at);
      this.closeSegment(s.id, end, "heartbeat-lost");
      this.db
        .prepare(
          "UPDATE study_session SET state='paused',end_reason='heartbeat-lost' WHERE id=?",
        )
        .run(s.id);
      this.audit(s.id, at, "heartbeat-lost", s, { ...s, state: "paused" });
      return;
    }
    const input = this.#lastInput.get(s.id) ?? s.last_heartbeat_at;
    if (input && at - input > this.config.session.idleMinutes * 60_000) {
      const end = Math.min(max, input + 60_000);
      this.closeSegment(s.id, end, "idle");
      this.db
        .prepare(
          "UPDATE study_session SET state='paused',last_heartbeat_at=? WHERE id=?",
        )
        .run(at, s.id);
      this.audit(s.id, at, "idle", s, { ...s, state: "paused", endedAt: end });
    }
  }
  stats() {
    const rows = this.db
      .prepare(
        "SELECT ss.state,ss.started_at,ss.ended_at,ss.nid,sg.started_at AS seg_start,sg.ended_at AS seg_end FROM study_session ss JOIN session_segment sg ON sg.session_id=ss.id WHERE ss.state!='discarded'",
      )
      .all() as unknown as {
      started_at: number;
      ended_at: number | null;
      state: string;
      nid: string | null;
      seg_start: number;
      seg_end: number | null;
    }[];
    const now = this.now();
    const intervals = rows.map((r) => ({
      start: r.seg_start,
      end: r.seg_end ?? (r.state === "running" ? now : r.seg_start),
    }));
    const byTopic = new Map<string, typeof intervals>();
    const general: typeof intervals = [];
    rows.forEach((row, index) => {
      if (row.nid === null) general.push(intervals[index]!);
      else {
        const group = byTopic.get(row.nid) ?? [];
        group.push(intervals[index]!);
        byTopic.set(row.nid, group);
      }
    });
    const intervalTotal = (group: typeof intervals) =>
      Object.values(dailyStudyTime(group, this.zone, now)).reduce(
        (sum, ms) => sum + ms,
        0,
      );
    const dailyMs = dailyStudyTime(intervals, this.zone, now);
    const today = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(this.zone)
      .toPlainDate()
      .toString();
    return {
      timeZone: this.zone,
      today,
      dailyMs,
      streak: streakSummary(dailyMs, today),
      totalMs: Object.values(dailyMs).reduce((a, b) => a + b, 0),
      todayMs: dailyMs[today] ?? 0,
      focusByNid: Object.fromEntries(
        [...byTopic].map(([nid, group]) => [nid, intervalTotal(group)]),
      ),
      generalMs: intervalTotal(general),
    };
  }
}
