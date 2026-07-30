// Shared, DOM-free historical-state lookup — used both by the debug
// viewer's delayed-live buffer (keyed by capturedAt, wall-clock ms) and by
// recording playback (keyed by offsetMs, ms since recording start). Same
// underlying question either way: "what was the state at or before this
// point in time?"

export interface TimestampedState<T> {
  time: number;
  value: T;
}

/**
 * Binary search for the latest entry whose `time` is <= targetTime, over a
 * `time`-ascending array. Returns undefined if `states` is empty or every
 * entry's time is after targetTime (i.e. targetTime is before the first
 * recorded/buffered state).
 *
 * Tie-break for duplicate `time` values: returns the LAST matching entry
 * in array order (the search keeps moving right on a match rather than
 * stopping at the first one found), so among several entries sharing the
 * same timestamp, the most-recently-appended one wins.
 */
export function findStateAtOrBefore<T>(
  states: readonly TimestampedState<T>[],
  targetTime: number
): TimestampedState<T> | undefined {
  let lo = 0;
  let hi = states.length - 1;
  let result: TimestampedState<T> | undefined;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = states[mid];
    if (!candidate) break;
    if (candidate.time <= targetTime) {
      result = candidate;
      lo = mid + 1; // a later entry might also qualify — keep looking right
    } else {
      hi = mid - 1;
    }
  }

  return result;
}

const DEFAULT_RETENTION_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * A rolling time-ordered window of the most recent ~retentionMs of values,
 * with a secondary hard cap on entry count as a defensive bound against a
 * pathologically high push rate. Does not itself deduplicate semantically
 * identical values — it relies on producers (e.g. OverlayStatePublisher's
 * fingerprint-based dedup) to not push near-identical states back to back
 * in the first place.
 */
export class TimeWindowBuffer<T> {
  private entries: TimestampedState<T>[] = [];

  constructor(
    private readonly retentionMs: number = DEFAULT_RETENTION_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES
  ) {}

  /**
   * Appends a new entry. Rejects (logs a warning, does not throw) a time
   * that moves strictly backward relative to the most recently pushed
   * entry — the buffer's binary-search lookup assumes a time-ascending
   * array, and a capturedAt that regresses is a clock/ordering anomaly
   * worth surfacing rather than silently corrupting future lookups. A
   * duplicate time (equal to, not less than, the last entry) is accepted —
   * see findStateAtOrBefore's tie-break.
   */
  push(time: number, value: T): void {
    const last = this.entries[this.entries.length - 1];
    if (last && time < last.time) {
      console.warn(`[history] rejected an out-of-order push (time=${time}, last=${last.time})`);
      return;
    }

    this.entries.push({ time, value });
    this.prune(time);
  }

  private prune(newestTime: number): void {
    const cutoff = newestTime - this.retentionMs;
    let dropCount = 0;
    while (dropCount < this.entries.length) {
      const entry = this.entries[dropCount];
      if (!entry || entry.time >= cutoff) break;
      dropCount++;
    }
    if (dropCount > 0) this.entries.splice(0, dropCount);

    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) this.entries.splice(0, overflow);
  }

  findAtOrBefore(targetTime: number): TimestampedState<T> | undefined {
    return findStateAtOrBefore(this.entries, targetTime);
  }

  get size(): number {
    return this.entries.length;
  }

  get earliestTime(): number | undefined {
    return this.entries[0]?.time;
  }

  get latestTime(): number | undefined {
    return this.entries[this.entries.length - 1]?.time;
  }

  clear(): void {
    this.entries = [];
  }
}
