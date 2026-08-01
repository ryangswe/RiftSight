import { normalizeBounds, type PixelBounds } from "./coordinates.js";
import { toProtocolZone, type DetectorZone } from "./zone.js";
import type { Owner, OverlayCard, Visibility } from "./types.js";

/**
 * Structural subset of the browser-only CardDetection the extension
 * produces. Deliberately not importing extension's actual type (which
 * carries a raw HTMLElement) so this package stays DOM-free and directly
 * unit-testable in Node.
 */
export interface DetectionInput {
  instanceId: string;
  cardId: string | undefined;
  name: string | undefined;
  imageUrl: string | undefined;
  visibility: Visibility;
  dropZone: DetectorZone;
  owner: Owner;
  rotationDeg: number;
  zIndexHint: number | undefined;
  bounds: PixelBounds;
  landscape: boolean;
}

/**
 * The second privacy boundary — the first is card-detector.ts's own
 * visibility classification, in the extension package. This function
 * independently re-checks `visibility === "public"` before copying any
 * identity-bearing field across; it does not trust that the input was
 * already clean. Even a hypothetical future detector bug that populates
 * cardId/name/imageUrl on a hidden or unknown-visibility card cannot leak
 * through here. See protocol/src/serializer.test.ts for the proof.
 *
 * Returns null when bounds can't be normalized (degenerate or fully
 * off-screen) rather than emitting a card with garbage geometry.
 */
export function toOverlayCard(
  detection: DetectionInput,
  viewport: { width: number; height: number }
): OverlayCard | null {
  const bounds = normalizeBounds(detection.bounds, viewport);
  if (!bounds) return null;

  const isPublic = detection.visibility === "public";

  return {
    instanceId: detection.instanceId,
    cardId: isPublic ? detection.cardId : undefined,
    name: isPublic ? detection.name : undefined,
    imageUrl: isPublic ? detection.imageUrl : undefined,
    zone: toProtocolZone(detection.dropZone),
    owner: detection.owner,
    visibility: detection.visibility,
    bounds,
    rotation: detection.rotationDeg,
    zIndex: detection.zIndexHint,
    landscape: detection.landscape,
  };
}
