import type { z } from "zod";
import type {
  NormalizedBoundsSchema,
  OverlayCardSchema,
  OverlayStateSchema,
  OwnerSchema,
  ProducerMessageSchema,
  ServerMessageSchema,
  SubscribeMessageSchema,
  TwitchSubscribeMessageSchema,
  VisibilitySchema,
  ViewportSchema,
  ZoneSchema,
} from "./schema.js";

export type ProtocolZone = z.infer<typeof ZoneSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type NormalizedBounds = z.infer<typeof NormalizedBoundsSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type OverlayCard = z.infer<typeof OverlayCardSchema>;
export type OverlayState = z.infer<typeof OverlayStateSchema>;
export type ProducerMessage = z.infer<typeof ProducerMessageSchema>;
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;
export type TwitchSubscribeMessage = z.infer<typeof TwitchSubscribeMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
