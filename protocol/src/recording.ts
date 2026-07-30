// Development-only recording of OverlayState snapshots over time, for
// later synchronized playback against a prerecorded RiftAtlas video.
// Entirely local: nothing here talks to the relay or any server — a
// recording lives in browser memory until exported to a JSON file the
// user saves themselves.

import { z } from "zod";
import { fingerprintCards } from "./fingerprint.js";
import { OverlayStateSchema } from "./schema.js";
import type { OverlayState } from "./types.js";

export const RECORDING_VERSION = 1 as const;

export const RecordedOverlayStateSchema = z.object({
  offsetMs: z.number().finite().nonnegative(),
  state: OverlayStateSchema,
});

export const OverlayRecordingSchema = z.object({
  recordingVersion: z.literal(RECORDING_VERSION),
  createdAt: z.number().finite().nonnegative(),
  sourceViewport: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  durationMs: z.number().finite().nonnegative(),
  states: z.array(RecordedOverlayStateSchema),
});

export type RecordedOverlayState = z.infer<typeof RecordedOverlayStateSchema>;
export type OverlayRecording = z.infer<typeof OverlayRecordingSchema>;

export type ParseRecordingResult = { recording: OverlayRecording } | { error: string };

/**
 * JSON.parse (catch) -> schema validation (structural rejection with a
 * concise error, including an unsupported recordingVersion, which
 * z.literal(RECORDING_VERSION) already rejects) -> sort states by
 * offsetMs. Sorting rather than rejecting an unsorted-but-otherwise-valid
 * recording is a deliberate "safe" normalization: offsetMs is purely a
 * lookup key, so reordering by it can't lose or misrepresent information,
 * unlike e.g. reordering by an implied causal sequence would.
 */
export function parseRecording(raw: string): ParseRecordingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Not valid JSON." };
  }

  const result = OverlayRecordingSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    return { error: firstIssue ? `${firstIssue.path.join(".") || "(root)"}: ${firstIssue.message}` : "Recording failed validation." };
  }

  const recording = result.data;
  const sortedStates = [...recording.states].sort((a, b) => a.offsetMs - b.offsetMs);
  return { recording: { ...recording, states: sortedStates } };
}

/**
 * Accumulates OverlayState snapshots while recording is active. Pure
 * enough to unit test directly (no DOM) — the debug viewer only wires
 * start/stop/clear to buttons and record() to the same onState pipeline
 * that already feeds the delayed-live buffer.
 */
export class OverlayRecorder {
  private recording = false;
  private startedAt = 0;
  private states: RecordedOverlayState[] = [];
  private lastFingerprint: string | null = null;

  start(now: number = Date.now()): void {
    this.recording = true;
    this.startedAt = now;
    this.states = [];
    this.lastFingerprint = null;
  }

  stop(): void {
    this.recording = false;
  }

  isRecording(): boolean {
    return this.recording;
  }

  get length(): number {
    return this.states.length;
  }

  /**
   * No-ops if not currently recording. Skips a state that's semantically
   * identical to the last recorded one — same dedup approach as
   * OverlayStatePublisher (fingerprintCards over cards + viewport), not a
   * separate mechanism, so "meaningfully changed" means the same thing in
   * both places.
   */
  record(state: OverlayState, now: number = Date.now()): void {
    if (!this.recording) return;

    const fingerprint = fingerprintCards(state.cards, state.sourceViewport);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;

    this.states.push({ offsetMs: Math.max(0, now - this.startedAt), state });
  }

  clear(): void {
    this.states = [];
    this.lastFingerprint = null;
  }

  /**
   * Null if nothing was recorded — there's no meaningful empty recording
   * to export. sourceViewport is derived from the first recorded state's
   * own sourceViewport (what RiftAtlas's viewport actually was when
   * recording began) rather than taken as a caller-supplied parameter —
   * the debug viewer's own window size would be the wrong, unrelated
   * value to use here.
   */
  toRecording(now: number = Date.now()): OverlayRecording | null {
    const firstState = this.states[0];
    if (!firstState) return null;
    const lastState = this.states[this.states.length - 1];
    return {
      recordingVersion: RECORDING_VERSION,
      createdAt: now,
      sourceViewport: firstState.state.sourceViewport,
      durationMs: lastState ? lastState.offsetMs : 0,
      states: this.states,
    };
  }
}
