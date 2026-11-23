import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configFrom } from "./config";
import { SessionService } from "./sessions";

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("./db/migrations/001-initial.sql", import.meta.url),
      "utf8",
    ),
  );
  let now = Date.parse("2026-01-01T10:00:00Z");
  const config = configFrom({
    vaultPath: "/tmp/synapse-session-vault",
    dataDir: "/tmp/synapse-session-state",
    timezone: "UTC",
  });
  const service = new SessionService(db, config, "UTC", () => now);
  return {
    db,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
describe("persistent study sessions", () => {
  it("enforces one active session and records pause/resume/stop segments", () => {
    const h = harness();
    const first = h.service.start(null)!;
    expect(() => h.service.start(null)).toThrow();
    h.advance(60_000);
    h.service.action(first.id, "pause");
    h.advance(30_000);
    h.service.action(first.id, "resume");
    h.advance(90_000);
    h.service.action(first.id, "stop");
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM session_segment WHERE session_id=?")
        .get(first.id),
    ).toMatchObject({ n: 2 });
    expect(
      h.db.prepare("SELECT state FROM study_session WHERE id=?").get(first.id),
    ).toMatchObject({ state: "ended" });
    expect(h.service.stats().totalMs).toBe(150_000);
    h.service.close();
    h.db.close();
  });
  it("closes idle and heartbeat-lost segments conservatively, and bounds idle restore", () => {
    const h = harness();
    const idle = h.service.start(null)!;
    const start = h.now();
    for (let i = 0; i < 31; i++) {
      h.advance(30_000);
      h.service.heartbeat(idle.id, start);
    }
    h.advance(30_000);
    h.service.tick();
    const seg = h.db
      .prepare("SELECT * FROM session_segment WHERE session_id=?")
      .get(idle.id) as { id: number; ended_at: number; close_reason: string };
    expect(seg.close_reason).toBe("idle");
    expect(seg.ended_at).toBe(Date.parse("2026-01-01T10:01:00Z"));
    expect(h.service.restoreIdle(idle.id, seg.id)).toBeTruthy();
    expect(() => h.service.restoreIdle(idle.id, seg.id)).toThrow();
    h.service.action(idle.id, "stop");
    const second = h.service.start(null)!;
    h.advance(121_000);
    h.service.tick();
    expect(
      h.db
        .prepare("SELECT state,end_reason FROM study_session WHERE id=?")
        .get(second.id),
    ).toMatchObject({ state: "paused", end_reason: "heartbeat-lost" });
    h.service.close();
    h.db.close();
  });
  it("closes interrupted running sessions at the last heartbeat on recovery", () => {
    const h = harness();
    const session = h.service.start(null)!;
    h.advance(90_000);
    h.service.close();
    const recovered = new SessionService(
      h.db,
      configFrom({
        vaultPath: "/tmp/synapse-session-vault",
        dataDir: "/tmp/synapse-session-state",
        timezone: "UTC",
      }),
      "UTC",
      h.now,
    );
    expect(
      h.db
        .prepare("SELECT state,end_reason FROM study_session WHERE id=?")
        .get(session.id),
    ).toMatchObject({ state: "paused", end_reason: "server-restart" });
    expect(
      h.db
        .prepare("SELECT ended_at FROM session_segment WHERE session_id=?")
        .get(session.id),
    ).toMatchObject({ ended_at: session.started_at });
    recovered.close();
    h.db.close();
  });
  it("auto-stops at four active hours", () => {
    const h = harness();
    const session = h.service.start(null)!;
    const start = h.now();
    for (let i = 0; i < 240; i++) {
      h.advance(60_000);
      h.service.heartbeat(session.id, h.now());
    }
    expect(
      h.db
        .prepare("SELECT state,end_reason FROM study_session WHERE id=?")
        .get(session.id),
    ).toMatchObject({ state: "ended", end_reason: "max-duration" });
    expect(
      h.db
        .prepare("SELECT ended_at FROM session_segment WHERE session_id=?")
        .get(session.id),
    ).toMatchObject({ ended_at: start + 4 * 60 * 60_000 });
    h.service.close();
    h.db.close();
  });
});
