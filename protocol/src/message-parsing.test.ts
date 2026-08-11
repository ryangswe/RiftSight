import { describe, expect, it, vi } from "vitest";
import { parseServerMessage } from "./message-parsing.js";

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
      cardId: "OGN-089",
      bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
      rotation: 0,
      landscape: false,
      localWidth: 0.1,
      localHeight: 0.1,
      fromDialog: false,
    },
  ],
};

function serverMessage(payload: unknown): string {
  return JSON.stringify({ type: "overlay-state", payload });
}

describe("parseServerMessage", () => {
  it("accepts a well-formed message and returns its payload", () => {
    expect(parseServerMessage(serverMessage(validState))).toEqual(validState);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(() => parseServerMessage("{not json")).not.toThrow();
    expect(parseServerMessage("{not json")).toBeUndefined();
  });

  it("rejects a message with a missing payload", () => {
    expect(parseServerMessage(JSON.stringify({ type: "overlay-state" }))).toBeUndefined();
  });

  it("rejects an unrecognized message type", () => {
    expect(parseServerMessage(JSON.stringify({ type: "ping" }))).toBeUndefined();
  });

  it("rejects an unsupported protocol version", () => {
    expect(parseServerMessage(serverMessage({ ...validState, protocolVersion: 2 }))).toBeUndefined();
  });

  it("rejects an invalid viewport", () => {
    const malformed = { ...validState, sourceViewport: { ...validState.sourceViewport, width: Infinity } };
    expect(parseServerMessage(serverMessage(malformed))).toBeUndefined();
  });

  it("rejects invalid bounds", () => {
    const malformed = { ...validState, cards: [{ ...validState.cards[0], bounds: { x: 0, y: 0, width: -1, height: 0.1 } }] };
    expect(parseServerMessage(serverMessage(malformed))).toBeUndefined();
  });

  it("rejects an unknown zone/owner/visibility", () => {
    expect(
      parseServerMessage(serverMessage({ ...validState, cards: [{ ...validState.cards[0], zone: "graveyard" }] }))
    ).toBeUndefined();
    expect(
      parseServerMessage(serverMessage({ ...validState, cards: [{ ...validState.cards[0], owner: "referee" }] }))
    ).toBeUndefined();
    expect(
      parseServerMessage(serverMessage({ ...validState, cards: [{ ...validState.cards[0], visibility: "peeking" }] }))
    ).toBeUndefined();
  });

  it("rejects a hidden card that still carries identity-bearing fields", () => {
    const malformed = {
      ...validState,
      cards: [{ ...validState.cards[0], visibility: "hidden", cardId: "OGN-213", name: "Should Not Appear" }],
    };
    expect(parseServerMessage(serverMessage(malformed))).toBeUndefined();
  });

  it("logs a concise reason (not the raw payload) when rejecting", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseServerMessage(serverMessage({ ...validState, protocolVersion: 2 }));
    expect(warnSpy).toHaveBeenCalled();
    const loggedArgs = warnSpy.mock.calls[0] ?? [];
    expect(JSON.stringify(loggedArgs)).not.toContain("OGN-089"); // no card data dumped
    warnSpy.mockRestore();
  });

  it("processes a later valid message normally after rejecting an invalid one", () => {
    expect(parseServerMessage(serverMessage({ ...validState, protocolVersion: 2 }))).toBeUndefined();
    // A rejected message has no memory/state to corrupt — the very next
    // call, independent of the previous one, still succeeds normally. This
    // is also what guarantees the viewer keeps rendering its last valid
    // state after a rejection: onState is only ever called with a defined
    // return value here, so a rejection simply means the caller doesn't
    // touch the DOM at all that round, not that it clears anything.
    expect(parseServerMessage(serverMessage(validState))).toEqual(validState);
  });
});
