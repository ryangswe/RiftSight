import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY_CONFIG, parseOverlayConfig, serializeOverlayConfig } from "./overlay-config.js";

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
    const config = { overlayEnabled: false, delayMs: 5000, debugOutlines: true, sourceAspectRatio: 1.778 };
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
});

describe("serializeOverlayConfig", () => {
  it("round-trips through parseOverlayConfig", () => {
    const config = { overlayEnabled: true, delayMs: 2000, debugOutlines: true, sourceAspectRatio: 1.6 };
    expect(parseOverlayConfig(serializeOverlayConfig(config))).toEqual(config);
  });
});
