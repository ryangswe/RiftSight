// Shared types for the RiftAtlas card detector.
//
// These describe what we can currently read from the DOM. Deliberately not
// the wire protocol format (OverlayCard, in @riftsight/protocol) — that's a
// narrower, privacy-filtered projection of this produced by
// content/publisher.ts via protocol's toOverlayCard().

export type DropZone =
  | "hand"
  | "base"
  | "battlefieldA"
  | "battlefieldB"
  | "runeArea"
  | "legend"
  | "champion"
  | "trash"
  | "chain"
  | "unknown";

export type Owner = "self" | "opponent" | "unknown";

/**
 * "public" means we positively confirmed — by reading the card's own
 * shared 3D-flip container's `transform` (see face-transform.ts), not
 * just DOM order — that the front face is the one actually rendered
 * right now. Anything else is "hidden" or "unknown" — and in both of
 * those cases cardId/imageUrl MUST be undefined. See card-detector.ts's
 * module header: every card slot renders both faces in the DOM
 * regardless of which is visible, so this classification is
 * load-bearing, not cosmetic.
 */
export type Visibility = "public" | "hidden" | "unknown";

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardDetection {
  /** RiftAtlas's own per-instance id (from data-card-id) — stable across re-renders. */
  instanceId: string;
  /** Set/number code parsed from the card image URL, e.g. "OGN-089". Only ever set when visibility === "public". */
  cardId: string | undefined;
  /** The visible face image's alt text (RiftAtlas's display name). Only ever set when visibility === "public". */
  name: string | undefined;
  /** Only ever set when visibility === "public" — see Visibility's doc comment. */
  imageUrl: string | undefined;
  visibility: Visibility;
  dropZone: DropZone;
  owner: Owner;
  /**
   * The card's net rotation, in degrees — resolved from the actual CSS
   * transform on the anchor or a nearby ancestor (see rotation.ts), not
   * from data-preview-rotation: that attribute was confirmed empirically
   * to stay "0" even on visibly rotated cards, so it governs something
   * else (likely the hover-preview panel's own orientation) rather than
   * the card's live board transform.
   */
  rotationDeg: number;
  landscape: boolean;
  /**
   * Real z-index, resolved from the anchor or a nearby ancestor (see
   * card-detector.ts's resolveZIndex) — RiftAtlas sets this on the same
   * ancestor rotationDeg comes from, not the anchor itself. Not
   * identity-sensitive — present regardless of visibility.
   */
  zIndexHint: number | undefined;
  bounds: PixelBounds;
  /**
   * The anchor's own true unrotated size (offsetWidth/offsetHeight) —
   * unlike bounds, this is unaffected by any CSS transform on the anchor
   * itself or any ancestor, since transforms don't participate in layout.
   * `bounds` is only the enclosing axis-aligned box of a rotated card (see
   * protocol's coordinates.ts), inflated relative to the card's true shape;
   * this pairs with rotationDeg and bounds' own center point to let a
   * consumer render the hitbox as the card's actual rotated shape instead
   * of the bloated AABB — see overlay-core's computeHitboxStyle.
   */
  localWidth: number;
  localHeight: number;
  /** True only for cards detected inside an active blocking dialog (Trash/Banished/Deck Peek/"Opponent revealed deck cards") — see card-detector.ts's detectDialogCards. False for every other detection path (normal board pass, mulligan). The signal a viewer uses to tell a dialog's own card apart from a background board card at the same screen position. */
  fromDialog: boolean;
  /** The anchor element this was built from. Not serializable — strip before logging/copying as JSON. */
  element: HTMLElement;
}
