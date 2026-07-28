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
});

describe("ProducerMessageSchema", () => {
  it("accepts a valid overlay-state message", () => {
    expect(ProducerMessageSchema.safeParse({ type: "overlay-state", payload: validState }).success).toBe(true);
  });

  it("rejects a message with the wrong type discriminant", () => {
    expect(ProducerMessageSchema.safeParse({ type: "subscribe", payload: validState }).success).toBe(false);
  });
});

describe("SubscribeMessageSchema", () => {
  it("requires a non-empty sessionId", () => {
    expect(SubscribeMessageSchema.safeParse({ type: "subscribe", sessionId: "" }).success).toBe(false);
    expect(SubscribeMessageSchema.safeParse({ type: "subscribe", sessionId: "local-debug" }).success).toBe(true);
  });
});
