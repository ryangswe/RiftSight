import { describe, expect, it } from "vitest";
import { fingerprintCards } from "./fingerprint.js";
import type { OverlayCard } from "./types.js";

const viewport = { width: 1920, height: 1080, devicePixelRatio: 1 };

function card(overrides: Partial<OverlayCard> = {}): OverlayCard {
  return {
    instanceId: "card_1",
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
    rotation: 0,
    landscape: false,
    localWidth: 0.1,
    localHeight: 0.1,
    fromDialog: false,
    ...overrides,
  };
}

describe("fingerprintCards", () => {
  it("is identical for the same cards regardless of input order", () => {
    const a = fingerprintCards([card({ instanceId: "card_1" }), card({ instanceId: "card_2" })], viewport);
    const b = fingerprintCards([card({ instanceId: "card_2" }), card({ instanceId: "card_1" })], viewport);
    expect(a).toBe(b);
  });

  it("changes when a card's position changes", () => {
    const a = fingerprintCards([card({ bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })], viewport);
    const b = fingerprintCards([card({ bounds: { x: 0.2, y: 0.1, width: 0.1, height: 0.1 } })], viewport);
    expect(a).not.toBe(b);
  });

  it("ignores sub-pixel float jitter in bounds", () => {
    const a = fingerprintCards([card({ bounds: { x: 0.100001, y: 0.1, width: 0.1, height: 0.1 } })], viewport);
    const b = fingerprintCards([card({ bounds: { x: 0.100002, y: 0.1, width: 0.1, height: 0.1 } })], viewport);
    expect(a).toBe(b);
  });

  it("changes when the card set size changes", () => {
    const a = fingerprintCards([card()], viewport);
    const b = fingerprintCards([card(), card({ instanceId: "card_2" })], viewport);
    expect(a).not.toBe(b);
  });

  it("changes when visibility changes even if geometry does not", () => {
    const a = fingerprintCards([card({ visibility: "public", cardId: "OGN-089" })], viewport);
    const b = fingerprintCards([card({ visibility: "hidden", cardId: undefined })], viewport);
    expect(a).not.toBe(b);
  });

  it("changes when fromDialog changes even if geometry does not", () => {
    const a = fingerprintCards([card({ fromDialog: false })], viewport);
    const b = fingerprintCards([card({ fromDialog: true })], viewport);
    expect(a).not.toBe(b);
  });

  it("changes when blockingRegion appears/disappears with identical cards", () => {
    const withoutRegion = fingerprintCards([card()], viewport);
    const withRegion = fingerprintCards([card()], viewport, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 });
    expect(withoutRegion).not.toBe(withRegion);
  });

  it("changes when blockingRegion moves", () => {
    const a = fingerprintCards([card()], viewport, { x: 0.3, y: 0.3, width: 0.2, height: 0.2 });
    const b = fingerprintCards([card()], viewport, { x: 0.4, y: 0.3, width: 0.2, height: 0.2 });
    expect(a).not.toBe(b);
  });

  it("ignores sub-pixel float jitter in blockingRegion", () => {
    const a = fingerprintCards([card()], viewport, { x: 0.300001, y: 0.3, width: 0.2, height: 0.2 });
    const b = fingerprintCards([card()], viewport, { x: 0.300002, y: 0.3, width: 0.2, height: 0.2 });
    expect(a).toBe(b);
  });
});
