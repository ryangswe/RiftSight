import type { z } from "zod";
import type {
  NormalizedBoundsSchema,
  OverlayCardSchema,
  OverlayStateSchema,
  OwnerSchema,
  TwitchSubscribeMessageSchema,
  VisibilitySchema,
  ViewerCountMessageSchema,
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
export type TwitchSubscribeMessage = z.infer<typeof TwitchSubscribeMessageSchema>;
export type ViewerCountMessage = z.infer<typeof ViewerCountMessageSchema>;
