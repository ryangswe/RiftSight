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

export const NormalizedBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const OverlayCardSchema = z.object({
  instanceId: z.string().min(1),
  cardId: z.string().optional(),
  name: z.string().optional(),
  imageUrl: z.string().optional(),
  zone: ZoneSchema,
  owner: OwnerSchema,
  visibility: VisibilitySchema,
  bounds: NormalizedBoundsSchema,
  rotation: z.number(),
  zIndex: z.number().optional(),
});

export const ViewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  devicePixelRatio: z.number().positive(),
});

export const OverlayStateSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  capturedAt: z.number(),
  sourceViewport: ViewportSchema,
  cards: z.array(OverlayCardSchema),
});

// Producer (extension background) -> relay.
export const ProducerMessageSchema = z.object({
  type: z.literal("overlay-state"),
  payload: OverlayStateSchema,
});

// Viewer -> relay.
export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  sessionId: z.string().min(1),
});

// Relay -> viewer.
export const ServerMessageSchema = z.object({
  type: z.literal("overlay-state"),
  payload: OverlayStateSchema,
});
