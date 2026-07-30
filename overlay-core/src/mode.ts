// Pure calculators for the viewer's timing modes. No DOM here — main.ts
// wires these to setInterval/video events and the TimeWindowBuffer.

export type ViewerMode = "live" | "delayed-live" | "recording-playback";

/**
 * delayed-live target: "what capturedAt should we be displaying right now."
 * Literally `now - delayMs`, per the milestone's own worked example.
 */
export function delayedLiveTarget(now: number, delayMs: number): number {
  return now - delayMs;
}

/**
 * True until at least delayMs of real wall-clock time has elapsed since we
 * started collecting history (bufferingSinceTime — when the viewer/buffer
 * began accumulating, not the buffer's oldest sample). Deliberately
 * time-based rather than sample-based: checking "is the buffer's oldest
 * sample old enough" instead breaks on a real, observed edge case — right
 * after (re)connecting, the relay replays its single retained latest
 * state, which can be arbitrarily old (e.g. from a session whose producer
 * stopped publishing) with a gap before any further history arrives. That
 * one stale sample being "old enough" would incorrectly read as
 * synchronized despite there being no actual continuous coverage back to
 * the target. Requiring delayMs of elapsed collection time instead matches
 * the spec's own framing directly: "waiting until at least N seconds of
 * history are available."
 */
export function isWaitingForHistory(bufferingSinceTime: number, delayMs: number, now: number): boolean {
  return now - bufferingSinceTime < delayMs;
}

/**
 * recording-playback target offset, in ms since the recording started.
 * Sign convention (documented here and in the UI): positive syncOffsetMs
 * advances the overlay timeline ahead of the video; negative delays it —
 * i.e. this is added, not subtracted, matching the milestone spec's own
 * formula verbatim.
 */
export function playbackTarget(videoCurrentTimeSec: number, syncOffsetMs: number): number {
  return videoCurrentTimeSec * 1000 + syncOffsetMs;
}

export type RecordingPlaybackStatus = "no-recording" | "before-start" | "synchronized" | "past-end";

/**
 * "before-start": targetOffsetMs is earlier than the first recorded state
 * — shown as an empty/waiting state, per the spec's requirement to handle
 * that case explicitly rather than showing stale or garbage data.
 * "past-end": targetOffsetMs is later than the last recorded state — we
 * still have a valid state to show (the last one), just flagged as
 * out-of-range so it's visible in diagnostics that playback has run past
 * the end of what was recorded. See findStateAtOrBefore/toRecording's
 * docs for why "keep showing the last state" is the chosen rule here.
 */
export function recordingPlaybackStatus(
  targetOffsetMs: number,
  firstOffsetMs: number | undefined,
  lastOffsetMs: number | undefined
): RecordingPlaybackStatus {
  if (firstOffsetMs === undefined || lastOffsetMs === undefined) return "no-recording";
  if (targetOffsetMs < firstOffsetMs) return "before-start";
  if (targetOffsetMs > lastOffsetMs) return "past-end";
  return "synchronized";
}
