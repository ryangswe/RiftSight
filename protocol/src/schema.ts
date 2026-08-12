// Zod schemas are the single source of truth for the wire protocol: types.ts
// re-exports the inferred TS types rather than declaring them separately, so
// the shape can't drift between compile-time types and runtime validation.
// This is what gets checked at every process boundary (relay accepting a
// producer/viewer message, viewer accepting a server message) — see the
// "runtime validation at process boundaries" requirement in project notes.

import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const ZoneSchema = z.enum([
  "battlefield",
  "runeArea",
  "base",
  "legend",
  "champion",
  "hand",
  "deck",
  "chain",
  "other",
  "unknown",
]);

export const OwnerSchema = z.enum(["self", "opponent", "unknown"]);

export const VisibilitySchema = z.enum(["public", "hidden", "unknown"]);

// Rejects blank/whitespace-only ids outright rather than trimming and
// accepting them — "invalid session ids are rejected", not silently
// normalized.
const SessionIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: "sessionId must not be blank" });

// `.finite()` matters here beyond `.min(1)`/`.positive()` alone — a bare
// z.number() rejects NaN but not Infinity/-Infinity, and a coordinate or
// dimension of Infinity would otherwise sail through.
export const NormalizedBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export const OverlayCardSchema = z
  .object({
    instanceId: z.string().min(1),
    cardId: z.string().optional(),
    name: z.string().optional(),
    imageUrl: z.string().optional(),
    zone: ZoneSchema,
    owner: OwnerSchema,
    visibility: VisibilitySchema,
    bounds: NormalizedBoundsSchema,
    rotation: z.number().finite(),
    zIndex: z.number().finite().optional(),
    // The card's true unrotated size, normalized the same way bounds is
    // (a fraction of sourceViewport). Paired with bounds' own center point
    // and `rotation` so a consumer can render a hitbox matching the card's
    // actual rotated shape instead of bounds' rotation-inflated AABB — see
    // overlay-core's computeHitboxStyle.
    localWidth: z.number().finite().nonnegative(),
    localHeight: z.number().finite().nonnegative(),
    // Whether the card's own art/frame is landscape-format — true for
    // Battlefield-type cards (see extension's data-preview-landscape
    // capture), independent of which zone the card currently sits in (a
    // portrait unit card played onto a battlefield zone stays landscape:
    // false). Drives popup sizing, not detection/geometry.
    landscape: z.boolean(),
    // True only for cards detected inside an active blocking dialog
    // (Trash/Banished/Deck Peek/"Opponent revealed deck cards"). The
    // foolproof "does this card belong to the dialog, not the board behind
    // it" signal for hover resolution — see OverlayState.blockingRegion.
    fromDialog: z.boolean(),
  })
  // A second, independent privacy boundary at the schema level (on top of
  // card-detector.ts's visibility classification and protocol's own
  // toOverlayCard() serializer): a non-public card must never carry
  // identity-bearing fields on the wire. Without this, a malformed or
  // rogue producer message with e.g. visibility "hidden" but a populated
  // cardId would pass validation and reach a viewer's network traffic even
  // though the UI never renders it — this closes that gap by rejecting the
  // whole message outright.
  .refine((card) => card.visibility === "public" || (!card.cardId && !card.name && !card.imageUrl), {
    message: "a non-public card must not carry identity fields (cardId/name/imageUrl)",
  });

export const ViewportSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  devicePixelRatio: z.number().finite().positive(),
});

export const OverlayStateSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: SessionIdSchema,
  sequence: z.number().int().nonnegative(),
  // Wall-clock Unix time (Date.now()) on the machine running the
  // extension, at the moment the source state was captured. This is only
  // meaningful because this prototype runs every component (extension,
  // relay, debug viewer) on one machine sharing one clock — comparing
  // capturedAt values across independent machines would be subject to
  // clock skew/drift with no correction applied anywhere in this codebase.
  // A production, multi-machine design would need a synchronized or
  // server-authoritative clock (e.g. NTP-disciplined timestamps, or
  // server-assigned sequence-based timing) instead of trusting raw
  // Date.now() deltas the way delayed-live's buffer and diagnostics do
  // here. No monotonic (performance.now()-style) field is added alongside
  // this for the same reason it isn't needed yet: every duration
  // calculation in this prototype (buffer retention, delayed-live target
  // time, recording offsetMs) is a delta of two capturedAt/Date.now()
  // reads on that same single machine, which is sufficient here.
  capturedAt: z.number().finite().nonnegative(),
  sourceViewport: ViewportSchema,
  cards: z.array(OverlayCardSchema),
  // The active blocking dialog's own bounding rect, present only while a
  // dialog is open. Board cards (fromDialog: false) publish their normal,
  // unclipped hitboxes always — a viewer suppresses hover for a background
  // card only when the hovered point also falls inside this rect, since
  // that's the only region actually painted over on top of the board.
  blockingRegion: NormalizedBoundsSchema.optional(),
});

// Producer (extension background) -> relay.
export const ProducerMessageSchema = z.object({
  type: z.literal("overlay-state"),
  payload: OverlayStateSchema,
});

// Viewer -> relay. Unauthenticated — the relay trusts whatever sessionId
// is supplied. Kept for the debug viewer and other local-debug use; a
// production deployment gates this off entirely via the relay's
// ALLOW_LOCAL_DEBUG config (see relay/src/server.ts), separate from the
// authenticated path below.
export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  sessionId: SessionIdSchema,
});

// Viewer -> relay, Twitch-authenticated path. `channelId` is the
// requested subscription target; the relay must verify `token` (a Twitch
// Extension JWT) and reject unless its own `channel_id` claim matches
// `channelId` — never trust the browser-supplied channelId on its own
// (see relay/src/twitch-auth.ts).
export const TwitchSubscribeMessageSchema = z.object({
  type: z.literal("twitch-subscribe"),
  channelId: z.string().min(1),
  token: z.string().min(1),
});

// Relay -> viewer.
export const ServerMessageSchema = z.object({
  type: z.literal("overlay-state"),
  payload: OverlayStateSchema,
});

// Relay -> producer. Lets the streamer's own extension know how many
// viewers are currently subscribed to their session — the producer socket
// was, until this, send-only (the extension never listened for anything
// coming back). Sent whenever the relay's own viewer count for that
// session changes, and once on producer connect/reconnect so a fresh
// connection doesn't have to wait for the next change to learn the
// current count.
export const ViewerCountMessageSchema = z.object({
  type: z.literal("viewer-count"),
  count: z.number().int().nonnegative(),
});
