import { Temporal } from "@js-temporal/polyfill";

export const STREAK_MIN_MS = 10 * 60 * 1000;
export type Interval = { start: number; end: number };

/** Union valid elapsed intervals, then split them at local midnight in an IANA zone. */
export function dailyStudyTime(
  intervals: Interval[],
  timeZone: string,
  now = Date.now(),
) {
  const valid = intervals
    .map(({ start, end }) => ({
      start: Math.max(0, start),
      end: Math.min(now, end),
    }))
    .filter(
      ({ start, end }) =>
        Number.isFinite(start) && Number.isFinite(end) && end > start,
    )
    .sort((a, b) => a.start - b.start);
  const union: Interval[] = [];
  for (const interval of valid) {
    const last = union.at(-1);
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else union.push({ ...interval });
  }
  const dailyMs: Record<string, number> = {};
  for (const interval of union) {
    let cursor = Temporal.Instant.fromEpochMilliseconds(
      interval.start,
    ).toZonedDateTimeISO(timeZone);
    const end = Temporal.Instant.fromEpochMilliseconds(interval.end);
    while (cursor.toInstant().epochMilliseconds < interval.end) {
      const day = cursor.toPlainDate().toString();
      const boundary = cursor
        .toPlainDate()
        .add({ days: 1 })
        .toZonedDateTime({ timeZone })
        .toInstant();
      const pieceEnd =
        boundary.epochMilliseconds < interval.end ? boundary : end;
      dailyMs[day] =
        (dailyMs[day] ?? 0) +
        pieceEnd.epochMilliseconds -
        cursor.toInstant().epochMilliseconds;
      cursor = pieceEnd.toZonedDateTimeISO(timeZone);
    }
  }
  return dailyMs;
}

export function streakSummary(dailyMs: Record<string, number>, today: string) {
  const qualifies = (day: string) => (dailyMs[day] ?? 0) >= STREAK_MIN_MS;
  const previous = Temporal.PlainDate.from(today)
    .subtract({ days: 1 })
    .toString();
  let current = 0;
  let cursor = Temporal.PlainDate.from(qualifies(today) ? today : previous);
  while (qualifies(cursor.toString())) {
    current++;
    cursor = cursor.subtract({ days: 1 });
  }
  const days = Object.keys(dailyMs)
    .filter((day) => qualifies(day))
    .sort();
  let longest = 0,
    run = 0,
    prior: Temporal.PlainDate | undefined;
  for (const day of days) {
    const date = Temporal.PlainDate.from(day);
    run = prior && prior.add({ days: 1 }).equals(date) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prior = date;
  }
  return { current, longest };
}
