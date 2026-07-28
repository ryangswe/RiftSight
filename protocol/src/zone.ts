import type { ProtocolZone } from "./types.js";

// Mirrors extension/src/content/types.ts's DropZone. Intentionally
// duplicated rather than imported — protocol must stay independent of the
// browser-only extension package (extension depends on protocol, not the
// reverse). Keep these two lists in sync if the detector's zone vocabulary
// changes.
export type DetectorZone =
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

const ZONE_MAP: Record<DetectorZone, ProtocolZone> = {
  hand: "hand",
  base: "base",
  battlefieldA: "battlefield",
  battlefieldB: "battlefield",
  runeArea: "runeArea",
  legend: "legend",
  champion: "champion",
  trash: "other",
  // Kept distinct rather than collapsed into "other" — the detector
  // already distinguishes the chain/stack, and that's useful information
  // a viewer may want to render differently.
  chain: "chain",
  unknown: "unknown",
};

export function toProtocolZone(zone: DetectorZone): ProtocolZone {
  return ZONE_MAP[zone];
}
