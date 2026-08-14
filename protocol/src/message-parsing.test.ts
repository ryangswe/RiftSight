import { describe, expect, it, vi } from "vitest";
import { parseServerMessage, parseViewerCountMessage, parseViewerServerMessage } from "./message-parsing.js";

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

describe("parseViewerCountMessage", () => {
  it("accepts a well-formed viewer-count message and returns the count", () => {
    expect(parseViewerCountMessage(JSON.stringify({ type: "viewer-count", count: 3 }))).toBe(3);
  });

  it("accepts a zero count", () => {
    expect(parseViewerCountMessage(JSON.stringify({ type: "viewer-count", count: 0 }))).toBe(0);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(() => parseViewerCountMessage("{not json")).not.toThrow();
    expect(parseViewerCountMessage("{not json")).toBeUndefined();
  });

  it("rejects a negative or non-integer count", () => {
    expect(parseViewerCountMessage(JSON.stringify({ type: "viewer-count", count: -1 }))).toBeUndefined();
    expect(parseViewerCountMessage(JSON.stringify({ type: "viewer-count", count: 1.5 }))).toBeUndefined();
  });

  it("rejects an unrecognized message type", () => {
    expect(parseViewerCountMessage(JSON.stringify({ type: "overlay-state", payload: {} }))).toBeUndefined();
  });
});

describe("parseViewerServerMessage", () => {
  it("returns a state event for an overlay-state message", () => {
    const event = parseViewerServerMessage(serverMessage(validState));
    expect(event).toBeDefined();
    expect(event?.kind).toBe("state");
    if (event?.kind === "state") {
      expect(event.state.sessionId).toBe("local-debug");
    }
  });

  it("returns a rejected event with its reason", () => {
    const event = parseViewerServerMessage(JSON.stringify({ type: "subscribe-rejected", reason: "unknown-channel" }));
    expect(event).toEqual({ kind: "rejected", reason: "unknown-channel" });
  });

  it("returns a ping event", () => {
    expect(parseViewerServerMessage(JSON.stringify({ type: "ping" }))).toEqual({ kind: "ping" });
  });

  it("fails closed on non-JSON, unknown types, and malformed payloads", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseViewerServerMessage("not json {")).toBeUndefined();
      expect(parseViewerServerMessage(JSON.stringify({ type: "viewer-count", count: 3 }))).toBeUndefined();
      expect(parseViewerServerMessage(serverMessage({ ...validState, protocolVersion: 2 }))).toBeUndefined();
      expect(parseViewerServerMessage(JSON.stringify({ type: "subscribe-rejected", reason: "nope" }))).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("enforces the schema-level privacy boundary on the state payload, same as parseServerMessage", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const leaked = {
        ...validState,
        cards: [{ ...validState.cards[0], visibility: "hidden", cardId: "OGN-213" }],
      };
      expect(parseViewerServerMessage(serverMessage(leaked))).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
