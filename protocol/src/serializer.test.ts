import { describe, expect, it } from "vitest";
import { toOverlayCard, type DetectionInput } from "./serializer.js";

const viewport = { width: 1000, height: 1000 };

function baseDetection(overrides: Partial<DetectionInput> = {}): DetectionInput {
  return {
    instanceId: "card_abc123",
    cardId: undefined,
    name: undefined,
    imageUrl: undefined,
    visibility: "unknown",
    dropZone: "hand",
    owner: "self",
    rotationDeg: 0,
    zIndexHint: undefined,
    bounds: { x: 100, y: 100, width: 100, height: 100 },
    landscape: false,
    ...overrides,
  };
}

describe("toOverlayCard", () => {
  it("includes identity fields for a public card", () => {
    const card = toOverlayCard(
      baseDetection({
        visibility: "public",
        cardId: "OGN-089",
        name: "Adaptatron",
        imageUrl: "https://example.com/a.webp",
      }),
      viewport
    );
    expect(card).not.toBeNull();
    expect(card!.cardId).toBe("OGN-089");
    expect(card!.name).toBe("Adaptatron");
    expect(card!.imageUrl).toBe("https://example.com/a.webp");
  });

  it("strips identity fields for a hidden card even when the input has them populated", () => {
    // Simulates a hypothetical detector bug: the input claims visibility
    // "hidden" but still carries real identity data. The serializer must
    // not trust that — this is the second, independent privacy boundary.
    const card = toOverlayCard(
      baseDetection({
        visibility: "hidden",
        cardId: "OGN-213",
        name: "Hidden Blade",
        imageUrl: "https://example.com/leak.webp",
      }),
      viewport
    );
    expect(card).not.toBeNull();
    expect(card!.cardId).toBeUndefined();
    expect(card!.name).toBeUndefined();
    expect(card!.imageUrl).toBeUndefined();
    // A hidden card is still allowed to expose non-identity fields.
    expect(card!.instanceId).toBe("card_abc123");
    expect(card!.visibility).toBe("hidden");
    expect(card!.zone).toBe("hand");
    expect(card!.owner).toBe("self");
  });

  it("also strips identity fields for 'unknown' visibility, not just 'hidden'", () => {
    const card = toOverlayCard(
      baseDetection({ visibility: "unknown", cardId: "OGN-999", name: "Should Not Appear" }),
      viewport
    );
    expect(card!.cardId).toBeUndefined();
    expect(card!.name).toBeUndefined();
  });

  it("maps battlefieldA/battlefieldB to the single 'battlefield' zone", () => {
    const a = toOverlayCard(baseDetection({ dropZone: "battlefieldA" }), viewport);
    const b = toOverlayCard(baseDetection({ dropZone: "battlefieldB" }), viewport);
    expect(a!.zone).toBe("battlefield");
    expect(b!.zone).toBe("battlefield");
  });

  it("passes landscape through independently of visibility (not an identity field)", () => {
    const a = toOverlayCard(baseDetection({ landscape: true, visibility: "public" }), viewport);
    const b = toOverlayCard(baseDetection({ landscape: true, visibility: "hidden" }), viewport);
    expect(a!.landscape).toBe(true);
    expect(b!.landscape).toBe(true);
  });

  it("returns null when bounds cannot be normalized", () => {
    const card = toOverlayCard(baseDetection({ bounds: { x: 0, y: 0, width: 0, height: 0 } }), viewport);
    expect(card).toBeNull();
  });
});
