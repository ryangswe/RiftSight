import { describe, expect, it } from "vitest";
import {
  OverlayStateSchema,
  OverlayWireConfigSchema,
  PingMessageSchema,
  ProducerMessageSchema,
  SourceRegionSchema,
  SubscribeMessageSchema,
  SubscribeRejectedMessageSchema,
  ViewerServerMessageSchema,
  YOUTUBE_CHANNEL_ID_PATTERN,
  YouTubeSubscribeMessageSchema,
} from "./schema.js";

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
      fromDialog: false,
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

  it("rejects a card missing fromDialog", () => {
    const { fromDialog: _fromDialog, ...cardWithoutFromDialog } = validState.cards[0]!;
    const malformed = { ...validState, cards: [cardWithoutFromDialog] };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("accepts a state with no blockingRegion (the common, no-dialog-open case)", () => {
    expect(OverlayStateSchema.safeParse(validState).success).toBe(true);
    expect((validState as { blockingRegion?: unknown }).blockingRegion).toBeUndefined();
  });

  it("accepts a state with a well-formed blockingRegion", () => {
    const withRegion = { ...validState, blockingRegion: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 } };
    expect(OverlayStateSchema.safeParse(withRegion).success).toBe(true);
  });

  it("rejects a state with a malformed blockingRegion", () => {
    const malformed = { ...validState, blockingRegion: { x: 0.3, y: 0.3, width: -0.2, height: 0.2 } };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects a hidden card with fromDialog: true that still carries identity fields — the privacy boundary applies regardless of fromDialog", () => {
    const malformed = {
      ...validState,
      cards: [{ ...validState.cards[0], fromDialog: true, visibility: "hidden", cardId: "OGN-213", name: "Should Not Appear" }],
    };
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

describe("SourceRegionSchema", () => {
  it("accepts a full-frame region", () => {
    expect(SourceRegionSchema.safeParse({ x: 0, y: 0, width: 1, height: 1 }).success).toBe(true);
  });

  it("accepts a region whose sum only exceeds 1 by float rounding", () => {
    expect(SourceRegionSchema.safeParse({ x: 1 / 3, y: 0, width: 2 / 3 + 1e-16, height: 1 }).success).toBe(true);
  });

  it("rejects a region extending past the frame", () => {
    expect(SourceRegionSchema.safeParse({ x: 0.5, y: 0, width: 0.6, height: 1 }).success).toBe(false);
  });

  it("rejects zero and negative dimensions", () => {
    expect(SourceRegionSchema.safeParse({ x: 0, y: 0, width: 0, height: 1 }).success).toBe(false);
    expect(SourceRegionSchema.safeParse({ x: 0, y: 0, width: 1, height: -0.5 }).success).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    expect(SourceRegionSchema.safeParse({ x: NaN, y: 0, width: 1, height: 1 }).success).toBe(false);
    expect(SourceRegionSchema.safeParse({ x: 0, y: 0, width: Infinity, height: 1 }).success).toBe(false);
  });
});

describe("OverlayWireConfigSchema", () => {
  it("accepts an empty config (every field optional)", () => {
    expect(OverlayWireConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully-populated config", () => {
    const config = {
      sourceRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      sourceAspectRatio: 16 / 9,
      tooltipScale: 1.2,
      overlayEnabled: true,
      recommendedDelayMs: 12000,
    };
    expect(OverlayWireConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects a negative recommendedDelayMs", () => {
    expect(OverlayWireConfigSchema.safeParse({ recommendedDelayMs: -1 }).success).toBe(false);
  });

  it("rejects a non-positive tooltipScale", () => {
    expect(OverlayWireConfigSchema.safeParse({ tooltipScale: 0 }).success).toBe(false);
  });
});

describe("OverlayStateSchema overlayConfig field", () => {
  it("accepts a state without overlayConfig (backward compatible)", () => {
    expect(OverlayStateSchema.safeParse(validState).success).toBe(true);
  });

  it("accepts and preserves a valid overlayConfig", () => {
    const withConfig = { ...validState, overlayConfig: { sourceRegion: { x: 0, y: 0, width: 0.5, height: 1 } } };
    const result = OverlayStateSchema.safeParse(withConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.overlayConfig?.sourceRegion).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
    }
  });

  it("rejects a state whose overlayConfig is malformed rather than stripping it", () => {
    const malformed = { ...validState, overlayConfig: { sourceRegion: { x: 0, y: 0, width: 2, height: 1 } } };
    expect(OverlayStateSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("YouTubeSubscribeMessageSchema", () => {
  const validChannelId = "UC" + "a1B2c3D4e5F6g7H8i9J0kL";

  it("accepts a canonical UC channel id", () => {
    expect(YOUTUBE_CHANNEL_ID_PATTERN.test(validChannelId)).toBe(true);
    expect(YouTubeSubscribeMessageSchema.safeParse({ type: "youtube-subscribe", channelId: validChannelId }).success).toBe(true);
  });

  it("rejects a handle, a URL, and a wrong-length id", () => {
    for (const channelId of ["@somehandle", "https://youtube.com/channel/UCabc", "UCshort", validChannelId + "x"]) {
      expect(YouTubeSubscribeMessageSchema.safeParse({ type: "youtube-subscribe", channelId }).success).toBe(false);
    }
  });
});

describe("ViewerServerMessageSchema", () => {
  it("accepts all three server->viewer shapes", () => {
    expect(ViewerServerMessageSchema.safeParse({ type: "overlay-state", payload: validState }).success).toBe(true);
    expect(ViewerServerMessageSchema.safeParse({ type: "subscribe-rejected", reason: "unknown-channel" }).success).toBe(true);
    expect(ViewerServerMessageSchema.safeParse({ type: "ping" }).success).toBe(true);
  });

  it("rejects an unknown rejection reason", () => {
    expect(SubscribeRejectedMessageSchema.safeParse({ type: "subscribe-rejected", reason: "server-melted" }).success).toBe(false);
  });

  it("rejects an unknown discriminant", () => {
    expect(ViewerServerMessageSchema.safeParse({ type: "viewer-count", count: 3 }).success).toBe(false);
    expect(PingMessageSchema.safeParse({ type: "pong" }).success).toBe(false);
  });
});
