import { describe, expect, it } from "vitest";
import type { OverlayCard } from "@riftsight/protocol";
import { cardPopupContentFor, tooltipContentFor } from "./tooltip.js";

function card(overrides: Partial<OverlayCard> = {}): OverlayCard {
  return {
    instanceId: "card_1",
    zone: "hand",
    owner: "self",
    visibility: "public",
    bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
    rotation: 0,
    ...overrides,
  };
}

describe("tooltipContentFor", () => {
  it("shows only 'Hidden card' and no image for a hidden card, regardless of other fields", () => {
    const content = tooltipContentFor(
      card({ visibility: "hidden", cardId: "OGN-213", name: "Should Not Appear", imageUrl: "https://example.com/leak.webp" })
    );
    expect(content.lines).toEqual(["Hidden card"]);
    expect(content.imageUrl).toBeUndefined();
  });

  it("shows only 'Hidden card' and no image for unknown visibility too", () => {
    const content = tooltipContentFor(card({ visibility: "unknown" }));
    expect(content.lines).toEqual(["Hidden card"]);
    expect(content.imageUrl).toBeUndefined();
  });

  it("shows identity details and the art image for a public card", () => {
    const content = tooltipContentFor(
      card({ visibility: "public", cardId: "OGN-089", name: "Adaptatron", imageUrl: "https://example.com/a.webp" })
    );
    expect(content.lines.join("\n")).toContain("Adaptatron");
    expect(content.lines.join("\n")).toContain("OGN-089");
    expect(content.imageUrl).toBe("https://example.com/a.webp");
  });

  it("still shows text for a public card with no resolved image", () => {
    const content = tooltipContentFor(card({ visibility: "public", cardId: "OGN-089", imageUrl: undefined }));
    expect(content.lines.length).toBeGreaterThan(0);
    expect(content.imageUrl).toBeUndefined();
  });
});

describe("cardPopupContentFor", () => {
  it("shows no image and a generic label for a hidden card, regardless of other fields", () => {
    const content = cardPopupContentFor(
      card({ visibility: "hidden", cardId: "OGN-213", name: "Should Not Appear", imageUrl: "https://example.com/leak.webp" })
    );
    expect(content.imageUrl).toBeUndefined();
    expect(content.altText).toBe("Hidden card");
    expect(content.fallbackLabel).toBe("Hidden card");
  });

  it("shows no image and a generic label for unknown visibility too", () => {
    const content = cardPopupContentFor(card({ visibility: "unknown" }));
    expect(content.imageUrl).toBeUndefined();
    expect(content.altText).toBe("Hidden card");
  });

  it("shows the art and a concise name-based alt for a public card", () => {
    const content = cardPopupContentFor(
      card({ visibility: "public", cardId: "OGN-089", name: "Adaptatron", imageUrl: "https://example.com/a.webp" })
    );
    expect(content.imageUrl).toBe("https://example.com/a.webp");
    expect(content.altText).toBe("Adaptatron");
    expect(content.altText).not.toContain("·"); // never the full zone/owner text
  });

  it("falls back to cardId, then instanceId, when name is missing", () => {
    expect(cardPopupContentFor(card({ visibility: "public", cardId: "OGN-089", name: undefined })).altText).toBe(
      "OGN-089"
    );
    expect(
      cardPopupContentFor(card({ visibility: "public", cardId: undefined, name: undefined, instanceId: "card_9" }))
        .altText
    ).toBe("card_9");
  });

  it("has no image and a fallback label for a public card with no resolved image", () => {
    const content = cardPopupContentFor(card({ visibility: "public", cardId: "OGN-089", imageUrl: undefined }));
    expect(content.imageUrl).toBeUndefined();
    expect(content.fallbackLabel).toBe("OGN-089");
  });
});
