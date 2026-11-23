export interface ExerciseIdentity {
  fingerprint: string;
  section: string;
  ordinal: number;
  text: string;
}

export interface ExerciseMatch<
  T extends ExerciseIdentity,
  U extends ExerciseIdentity,
> {
  previous: T;
  current: U | null;
  reason: "unchanged" | "reworded" | "orphaned";
}

function words(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared++;
  }
  return (2 * shared) / (left.size + right.size);
}

/**
 * Match saved ticks to the current parsed list. Reserve all exact matches first
 * so a removed/reworded exercise cannot steal a later exercise's saved tick.
 */
export function matchExercises<
  T extends ExerciseIdentity,
  U extends ExerciseIdentity,
>(previous: readonly T[], current: readonly U[]): ExerciseMatch<T, U>[] {
  const available = new Set(current);
  const matches: ExerciseMatch<T, U>[] = previous.map((item) => ({
    previous: item,
    current: null,
    reason: "orphaned",
  }));
  for (const match of matches) {
    const old = match.previous;
    const exact = [...available].filter(
      (item) => item.fingerprint === old.fingerprint,
    );
    const found =
      exact.find(
        (item) => item.section === old.section && item.ordinal === old.ordinal,
      ) ??
      exact.find((item) => item.section === old.section) ??
      exact[0];
    if (found) {
      available.delete(found);
      match.current = found;
      match.reason = "unchanged";
    }
  }
  for (const match of matches) {
    if (match.current) continue;
    const old = match.previous;
    const found = [...available].find(
      (item) => item.ordinal === old.ordinal && item.section === old.section,
    );
    if (found && similarity(old.text, found.text) >= 0.6) {
      available.delete(found);
      match.current = found;
      match.reason = "reworded";
    }
  }
  return matches;
}
