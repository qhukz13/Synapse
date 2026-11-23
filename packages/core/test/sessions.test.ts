import { describe, expect, it } from "vitest";
import { dailyStudyTime, STREAK_MIN_MS, streakSummary } from "../src/sessions";

const ms = (date: string) => Date.parse(date);
describe("study-time aggregation", () => {
  it("unions overlaps and splits intervals at local midnight", () => {
    const daily = dailyStudyTime(
      [
        { start: ms("2026-01-01T23:55:00Z"), end: ms("2026-01-02T00:08:00Z") },
        { start: ms("2026-01-02T00:02:00Z"), end: ms("2026-01-02T00:10:00Z") },
      ],
      "UTC",
      ms("2026-01-03T00:00:00Z"),
    );
    expect(daily).toEqual({
      "2026-01-01": 5 * 60_000,
      "2026-01-02": 10 * 60_000,
    });
  });
  it("handles split sessions, exact threshold, and both DST day lengths", () => {
    const day = "2026-01-02";
    expect(streakSummary({ [day]: 4 * 60_000 + 6 * 60_000 }, day).current).toBe(
      1,
    );
    expect(streakSummary({ [day]: STREAK_MIN_MS - 1 }, day).current).toBe(0);
    const spring = dailyStudyTime(
      [{ start: ms("2026-03-28T22:00:00Z"), end: ms("2026-03-29T21:00:00Z") }],
      "Europe/Kyiv",
      ms("2026-03-30T00:00:00Z"),
    );
    const fall = dailyStudyTime(
      [{ start: ms("2026-10-24T21:00:00Z"), end: ms("2026-10-25T22:00:00Z") }],
      "Europe/Kyiv",
      ms("2026-10-26T00:00:00Z"),
    );
    expect(spring["2026-03-29"]).toBe(23 * 60 * 60_000);
    expect(fall["2026-10-25"]).toBe(25 * 60 * 60_000);
  });
  it("keeps a streak alive while today is not qualified and clamps future ends", () => {
    expect(
      streakSummary(
        { "2026-04-02": STREAK_MIN_MS, "2026-04-03": STREAK_MIN_MS },
        "2026-04-04",
      ),
    ).toEqual({ current: 2, longest: 2 });
    expect(
      dailyStudyTime([{ start: 1000, end: 10_000 }], "UTC", 5000)["1970-01-01"],
    ).toBe(4000);
  });
});
