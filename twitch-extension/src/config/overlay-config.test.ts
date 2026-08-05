import { FULL_FRAME_SOURCE_REGION, SOURCE_REGION_PRESETS } from "@riftsight/overlay-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_CONFIG,
  MAX_DELAY_MS,
  MAX_TOOLTIP_SCALE,
  MIN_TOOLTIP_SCALE,
  parseOverlayConfig,
  serializeOverlayConfig,
} from "./overlay-config.js";

describe("parseOverlayConfig", () => {
  it("returns defaults for undefined content", () => {
    expect(parseOverlayConfig(undefined)).toEqual(DEFAULT_OVERLAY_CONFIG);
  });

  it("returns defaults for empty string content", () => {
    expect(parseOverlayConfig("")).toEqual(DEFAULT_OVERLAY_CONFIG);
  });

  it("returns defaults for malformed JSON", () => {
    expect(parseOverlayConfig("{not json")).toEqual(DEFAULT_OVERLAY_CONFIG);
  });

  it("returns defaults for a JSON value that isn't an object", () => {
    expect(parseOverlayConfig("42")).toEqual(DEFAULT_OVERLAY_CONFIG);
    expect(parseOverlayConfig("null")).toEqual(DEFAULT_OVERLAY_CONFIG);
    expect(parseOverlayConfig('"a string"')).toEqual(DEFAULT_OVERLAY_CONFIG);
  });

  it("parses a fully-specified valid config", () => {
    const config = {
      overlayEnabled: false,
      delayMs: 5000,
      debugOutlines: true,
      sourceAspectRatio: 1.778,
      sourceRegion: SOURCE_REGION_PRESETS.rightHalf,
      tooltipScale: 1.2,
    };
    expect(parseOverlayConfig(JSON.stringify(config))).toEqual(config);
  });

  it("fills in defaults for missing fields", () => {
    expect(parseOverlayConfig(JSON.stringify({ delayMs: 2000 }))).toEqual({
      ...DEFAULT_OVERLAY_CONFIG,
      delayMs: 2000,
    });
  });

  it("falls back to default delayMs for a negative value", () => {
    expect(parseOverlayConfig(JSON.stringify({ delayMs: -100 })).delayMs).toBe(DEFAULT_OVERLAY_CONFIG.delayMs);
  });

  it("falls back to default delayMs for a non-finite value", () => {
    expect(parseOverlayConfig(JSON.stringify({ delayMs: "not a number" })).delayMs).toBe(DEFAULT_OVERLAY_CONFIG.delayMs);
  });

  it("accepts a delayMs exactly at MAX_DELAY_MS", () => {
    expect(parseOverlayConfig(JSON.stringify({ delayMs: MAX_DELAY_MS })).delayMs).toBe(MAX_DELAY_MS);
  });

  it("falls back to default delayMs for a value above MAX_DELAY_MS — this is the bound that prevents a permanently blank overlay (the viewer's history buffer can't serve a delay longer than it retains)", () => {
    expect(parseOverlayConfig(JSON.stringify({ delayMs: MAX_DELAY_MS + 1 })).delayMs).toBe(DEFAULT_OVERLAY_CONFIG.delayMs);
  });

  it("ignores a non-boolean overlayEnabled/debugOutlines", () => {
    const result = parseOverlayConfig(JSON.stringify({ overlayEnabled: "yes", debugOutlines: 1 }));
    expect(result.overlayEnabled).toBe(DEFAULT_OVERLAY_CONFIG.overlayEnabled);
    expect(result.debugOutlines).toBe(DEFAULT_OVERLAY_CONFIG.debugOutlines);
  });

  it("ignores a non-positive sourceAspectRatio", () => {
    expect(parseOverlayConfig(JSON.stringify({ sourceAspectRatio: 0 })).sourceAspectRatio).toBeUndefined();
    expect(parseOverlayConfig(JSON.stringify({ sourceAspectRatio: -1.5 })).sourceAspectRatio).toBeUndefined();
  });

  it("debugOutlines defaults to false — debug mode is never on for normal viewers unless a broadcaster explicitly enabled it", () => {
    expect(DEFAULT_OVERLAY_CONFIG.debugOutlines).toBe(false);
    expect(parseOverlayConfig(undefined).debugOutlines).toBe(false);
    expect(parseOverlayConfig(JSON.stringify({})).debugOutlines).toBe(false);
  });

  it("tooltipScale defaults to 1 — a config saved before this field existed migrates to today's exact sizes", () => {
    expect(DEFAULT_OVERLAY_CONFIG.tooltipScale).toBe(1);
    expect(parseOverlayConfig(undefined).tooltipScale).toBe(1);
    expect(parseOverlayConfig(JSON.stringify({ overlayEnabled: true, delayMs: 1000 })).tooltipScale).toBe(1);
  });

  it("parses a valid custom tooltipScale within [MIN_TOOLTIP_SCALE, MAX_TOOLTIP_SCALE]", () => {
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: 1.1 })).tooltipScale).toBe(1.1);
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: MIN_TOOLTIP_SCALE })).tooltipScale).toBe(MIN_TOOLTIP_SCALE);
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: MAX_TOOLTIP_SCALE })).tooltipScale).toBe(MAX_TOOLTIP_SCALE);
  });

  it("rejects an out-of-range tooltipScale back to the default rather than clamping it", () => {
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: 0.1 })).tooltipScale).toBe(1);
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: 5 })).tooltipScale).toBe(1);
  });

  it("rejects a non-finite or non-number tooltipScale back to the default", () => {
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: "big" })).tooltipScale).toBe(1);
    expect(parseOverlayConfig(JSON.stringify({ tooltipScale: null })).tooltipScale).toBe(1);
  });

  // Migration: a config saved before sourceRegion existed (or one with a
  // corrupted/invalid region) must keep behaving exactly like the
  // full-frame-only milestone did — never crash, never silently render
  // hitboxes somewhere unexpected.
  it("defaults sourceRegion to full frame when the field is entirely missing (pre-migration config)", () => {
    const preMigrationConfig = { overlayEnabled: true, delayMs: 1000, debugOutlines: false };
    expect(parseOverlayConfig(JSON.stringify(preMigrationConfig)).sourceRegion).toEqual(FULL_FRAME_SOURCE_REGION);
  });

  it("falls back to full frame for a structurally-invalid sourceRegion", () => {
    expect(parseOverlayConfig(JSON.stringify({ sourceRegion: { x: 0.9, y: 0, width: 0.5, height: 0.5 } })).sourceRegion).toEqual(
      FULL_FRAME_SOURCE_REGION
    );
    expect(parseOverlayConfig(JSON.stringify({ sourceRegion: "not an object" })).sourceRegion).toEqual(FULL_FRAME_SOURCE_REGION);
  });

  it("parses a valid custom sourceRegion", () => {
    expect(parseOverlayConfig(JSON.stringify({ sourceRegion: SOURCE_REGION_PRESETS.centered })).sourceRegion).toEqual(
      SOURCE_REGION_PRESETS.centered
    );
  });
});

describe("serializeOverlayConfig", () => {
  it("round-trips through parseOverlayConfig", () => {
    const config = {
      overlayEnabled: true,
      delayMs: 2000,
      debugOutlines: true,
      sourceAspectRatio: 1.6,
      sourceRegion: SOURCE_REGION_PRESETS.leftHalf,
      tooltipScale: 0.75,
    };
    expect(parseOverlayConfig(serializeOverlayConfig(config))).toEqual(config);
  });

  it("round-trips sourceRegion changes not affecting other fields (independent field, not coupled state)", () => {
    const config = { ...DEFAULT_OVERLAY_CONFIG, sourceRegion: SOURCE_REGION_PRESETS.rightHalf };
    const roundTripped = parseOverlayConfig(serializeOverlayConfig(config));
    expect(roundTripped.sourceRegion).toEqual(SOURCE_REGION_PRESETS.rightHalf);
    expect(roundTripped.delayMs).toBe(DEFAULT_OVERLAY_CONFIG.delayMs);
    expect(roundTripped.debugOutlines).toBe(DEFAULT_OVERLAY_CONFIG.debugOutlines);
  });
});
