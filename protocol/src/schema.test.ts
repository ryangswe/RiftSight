import { describe, expect, it } from "vitest";
import { OverlayStateSchema, ProducerMessageSchema, SubscribeMessageSchema } from "./schema.js";

const validState = {
  protocolVersion: 1,
  sessionId: "local-debug",
  sequence: 1,
  capturedAt: Date.now(),
  sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
  cards: [
    {
      instanceId: "card_1",
      zone: "hand",
      owner: "self",
      visibility: "public",
      bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      rotation: 0,
      landscape: false,
      localWidth: 0.1,
      localHeight: 0.1,
    },
  ],
};

describe("OverlayStateSchema", () => {
  it("accepts a well-formed state", () => {
    expect(OverlayStateSchema.safeParse(validState).success).toBe(true);
  });

  it("rejects an unsupported protocol version", () => {
    expect(OverlayStateSchema.safeParse({ ...validState, protocolVersion: 2 }).success).toBe(false);
  });

  it("rejects a card missing required fields", () => {
    const malformed = { ...validState, cards: [{ instanceId: "card_1" }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an unknown zone value", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], zone: "graveyard" }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-positive viewport dimension", () => {
    const malformed = { ...validState, sourceViewport: { ...validState.sourceViewport, width: 0 } };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-finite viewport dimension", () => {
    const malformed = { ...validState, sourceViewport: { ...validState.sourceViewport, width: Infinity } };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-finite normalized bound", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], bounds: { x: 0, y: 0, width: Infinity, height: 0.1 } }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a negative width/height in normalized bounds", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], bounds: { x: 0, y: 0, width: -0.1, height: 0.1 } }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an unknown owner value", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], owner: "referee" }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an unknown visibility value", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], visibility: "peeking" }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a non-finite or negative sequence/capturedAt", () => {
    expect(OverlayStateSchema.safeParse({ ...validState, sequence: -1 }).success).toBe(false);
    expect(OverlayStateSchema.safeParse({ ...validState, sequence: 1.5 }).success).toBe(false);
    expect(OverlayStateSchema.safeParse({ ...validState, capturedAt: Infinity }).success).toBe(false);
    expect(OverlayStateSchema.safeParse({ ...validState, capturedAt: -1 }).success).toBe(false);
  });

  it("rejects a whitespace-only sessionId", () => {
    expect(OverlayStateSchema.safeParse({ ...validState, sessionId: "   " }).success).toBe(false);
  });

  it("rejects a hidden card that still carries identity-bearing fields — the schema-level privacy boundary", () => {
    const malformed = {
      ...validState,
      cards: [{ ...validState.cards[0], visibility: "hidden", cardId: "OGN-213", name: "Should Not Appear" }],
    };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects an unknown-visibility card carrying an imageUrl", () => {
    const malformed = {
      ...validState,
      cards: [{ ...validState.cards[0], visibility: "unknown", imageUrl: "https://example.com/leak.webp" }],
    };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("still accepts a public card with identity fields", () => {
    const withIdentity = {
      ...validState,
      cards: [{ ...validState.cards[0], visibility: "public", cardId: "OGN-089", name: "Adaptatron" }],
    };
    expect(OverlayStateSchema.safeParse(withIdentity).success).toBe(true);
  });

  it("rejects a card missing localWidth/localHeight", () => {
    const { localWidth: _localWidth, ...cardWithoutLocalWidth } = validState.cards[0]!;
    const malformed = { ...validState, cards: [cardWithoutLocalWidth] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a negative localWidth/localHeight", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], localWidth: -0.1 }] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("ProducerMessageSchema", () => {
  it("accepts a valid overlay-state message", () => {
    expect(ProducerMessageSchema.safeParse({ type: "overlay-state", payload: validState }).success).toBe(true);
  });

  it("rejects a message with the wrong type discriminant", () => {
    expect(ProducerMessageSchema.safeParse({ type: "subscribe", payload: validState }).success).toBe(false);
  });

  it("rejects a message with a missing payload", () => {
    expect(ProducerMessageSchema.safeParse({ type: "overlay-state" }).success).toBe(false);
  });
});

describe("SubscribeMessageSchema", () => {
  it("requires a non-empty sessionId", () => {
    expect(SubscribeMessageSchema.safeParse({ type: "subscribe", sessionId: "" }).success).toBe(false);
    expect(SubscribeMessageSchema.safeParse({ type: "subscribe", sessionId: "local-debug" }).success).toBe(true);
  });

  it("rejects a whitespace-only sessionId", () => {
    expect(SubscribeMessageSchema.safeParse({ type: "subscribe", sessionId: "   " }).success).toBe(false);
  });
});
