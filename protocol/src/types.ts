import type { z } from "zod";
import type {
  NormalizedBoundsSchema,
  OverlayCardSchema,
  OverlayStateSchema,
  OverlayWireConfigSchema,
  OwnerSchema,
  PingMessageSchema,
  SourceRegionSchema,
  SubscribeRejectedMessageSchema,
  SubscribeRejectedReasonSchema,
  TwitchSubscribeMessageSchema,
  ViewerServerMessageSchema,
  VisibilitySchema,
  ViewerCountMessageSchema,
  ViewportSchema,
  YouTubeSubscribeMessageSchema,
  ZoneSchema,
} from "./schema.js";

export type ProtocolZone = z.infer<typeof ZoneSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type NormalizedBounds = z.infer<typeof NormalizedBoundsSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type OverlayCard = z.infer<typeof OverlayCardSchema>;
export type OverlayState = z.infer<typeof OverlayStateSchema>;
export type TwitchSubscribeMessage = z.infer<typeof TwitchSubscribeMessageSchema>;
export type ViewerCountMessage = z.infer<typeof ViewerCountMessageSchema>;
// The single wire-level SourceRegion type — overlay-core re-exports this
// (rather than declaring its own) so the calibration helpers and the
// protocol can never drift structurally.
export type SourceRegion = z.infer<typeof SourceRegionSchema>;
export type OverlayWireConfig = z.infer<typeof OverlayWireConfigSchema>;
export type YouTubeSubscribeMessage = z.infer<typeof YouTubeSubscribeMessageSchema>;
export type SubscribeRejectedReason = z.infer<typeof SubscribeRejectedReasonSchema>;
export type SubscribeRejectedMessage = z.infer<typeof SubscribeRejectedMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type ViewerServerMessage = z.infer<typeof ViewerServerMessageSchema>;
