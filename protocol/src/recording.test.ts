import { describe, expect, it } from "vitest";
import { OverlayRecorder, OverlayRecordingSchema, parseRecording, RECORDING_VERSION } from "./recording.js";
import type { OverlayState } from "./types.js";

const viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };

function state(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    protocolVersion: 1,
    sessionId: "local-debug",
    sequence: 1,
    capturedAt: Date.now(),
    sourceViewport: viewport,
    cards: [
      {
        instanceId: "card_1",
        zone: "hand",
        owner: "self",
        visibility: "public",
        cardId: "OGN-089",
        bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        rotation: 0,
      },
    ],
    ...overrides,
  };
}

describe("OverlayRecorder", () => {
  it("records nothing before start() is called", () => {
    const recorder = new OverlayRecorder();
    recorder.record(state());
    expect(recorder.length).toBe(0);
  });

  it("records states with offsetMs relative to start", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state({ sequence: 1 }), 1000);
    recorder.record(state({ sequence: 2, cards: [] }), 1500);
    const recording = recorder.toRecording(2000);
    expect(recording).not.toBeNull();
    expect(recording!.states.map((s) => s.offsetMs)).toEqual([0, 500]);
    expect(recording!.durationMs).toBe(500);
  });

  it("stops recording new states after stop()", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state({ sequence: 1 }), 1000);
    recorder.stop();
    recorder.record(state({ sequence: 2, cards: [] }), 1500);
    expect(recorder.length).toBe(1);
  });

  it("skips a semantically identical consecutive state", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state({ sequence: 1 }), 1000);
    recorder.record(state({ sequence: 2 }), 1200); // same cards/viewport, only sequence differs
    expect(recorder.length).toBe(1);
  });

  it("records a state again once it actually changes", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state({ sequence: 1 }), 1000);
    recorder.record(state({ sequence: 2, cards: [] }), 1200); // genuinely different
    expect(recorder.length).toBe(2);
  });

  it("clear() empties the recording", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state(), 1000);
    recorder.clear();
    expect(recorder.length).toBe(0);
    expect(recorder.toRecording()).toBeNull();
  });

  it("toRecording() returns null when nothing was recorded", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    expect(recorder.toRecording()).toBeNull();
  });

  it("start() resets any previous recording", () => {
    const recorder = new OverlayRecorder();
    recorder.start(1000);
    recorder.record(state(), 1000);
    recorder.start(5000);
    expect(recorder.length).toBe(0);
  });
});

describe("OverlayRecordingSchema", () => {
  const validRecording = {
    recordingVersion: 1,
    createdAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080 },
    durationMs: 500,
    states: [
      { offsetMs: 0, state: state({ sequence: 1 }) },
      { offsetMs: 500, state: state({ sequence: 2 }) },
    ],
  };

  it("accepts a well-formed recording", () => {
    expect(OverlayRecordingSchema.safeParse(validRecording).success).toBe(true);
  });

  it("rejects an unsupported recording version", () => {
    expect(OverlayRecordingSchema.safeParse({ ...validRecording, recordingVersion: 2 }).success).toBe(false);
  });

  it("rejects a negative offsetMs", () => {
    const malformed = { ...validRecording, states: [{ offsetMs: -100, state: state() }] };
    expect(OverlayRecordingSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-finite offsetMs", () => {
    const malformed = { ...validRecording, states: [{ offsetMs: Infinity, state: state() }] };
    expect(OverlayRecordingSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an invalid nested OverlayState (reuses the same validation)", () => {
    const malformed = { ...validRecording, states: [{ offsetMs: 0, state: { ...state(), protocolVersion: 2 } }] };
    expect(OverlayRecordingSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("parseRecording", () => {
  const baseRecording = {
    recordingVersion: RECORDING_VERSION,
    createdAt: Date.now(),
    sourceViewport: { width: 1920, height: 1080 },
    durationMs: 1000,
    states: [
      { offsetMs: 1000, state: state({ sequence: 2 }) },
      { offsetMs: 0, state: state({ sequence: 1 }) },
    ],
  };

  it("returns an error for malformed JSON", () => {
    const result = parseRecording("{not json");
    expect("error" in result).toBe(true);
  });

  it("returns a clear error for a structurally invalid recording", () => {
    const result = parseRecording(JSON.stringify({ recordingVersion: 2 }));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.length).toBeGreaterThan(0);
  });

  it("normalizes an unsorted-but-valid recording into offsetMs order rather than rejecting it", () => {
    const result = parseRecording(JSON.stringify(baseRecording));
    expect("recording" in result).toBe(true);
    if ("recording" in result) {
      expect(result.recording.states.map((s) => s.offsetMs)).toEqual([0, 1000]);
    }
  });
});
