// Card detector for RiftAtlas.
//
// Anchors on [data-card-id], which RiftAtlas attaches to every real card
// instance — hand, base, battlefield, rune area, legend, champion, trash,
// and the chain. Real per-instance cards use ids like "card_18076bb4" (an
// earlier capture's short hex form) or a full UUID like
// "card_80552594-720d-493b-b569-8ed4162a75b4" (seen in a later capture,
// same room type — RiftAtlas evidently doesn't guarantee one fixed id
// shape). CARD_INSTANCE_ID_PATTERN accepts both rather than assuming
// either is the only one that'll ever appear: a real live incident showed
// the short-hex-only version of this pattern silently rejecting every
// UUID-shaped card id, which meant only the two battlefield markers (their
// own separate, unaffected pattern) were ever detected — 41 real cards on
// the board went completely undetected with no error, only an
// unexpectedly-low card count. Battlefield-type cards (Windswept Hillock,
// Star Spring, ...) are the one exception found so far: RiftAtlas gives
// them the slot's own marker id ("battlefield-marker:battlefieldA"/"...B")
// instead of a card_ id, so that's its own separate accepted pattern. The
// base-area marker ("base-area-marker:...") is a different, much larger
// drop target covering a whole lane — not a specific card — and stays
// excluded.
//
// CRITICAL, established from a live capture: every card slot renders BOTH
// its front-face image and a cardback image in the DOM simultaneously (used
// for the flip-in animation), regardless of which face is currently visible
// to the viewer. An earlier version of this detector took the first
// <img src> found, which meant it reported the real cardId/imageUrl for a
// card that was visually face-down on the board — a direct violation of the
// project's "must not expose hidden card identities" requirement. That is
// likely a latent data-exposure issue in RiftAtlas itself (worth reporting
// upstream), but regardless, this module must fail closed: cardId/imageUrl
// are only ever populated when resolveVisibleFace() has positively
// confirmed — via real hit-testing, not DOM order — that a non-cardback
// face is the one actually being rendered right now. See Visibility's doc
// comment in types.ts.

import { resolveElementRotationDeg } from "./rotation.js";
import type { CardDetection, DropZone, Owner, PixelBounds, Visibility } from "./types.js";

const CARD_IMAGE_URL_PATTERN = /\/cards\/(?:original|small-v2)\/([A-Z0-9]+-\d+)\.webp/;
// Deliberately permissive on shape (hex digits and dashes, any length)
// rather than pinned to one exact id format — see the module header for
// why: RiftAtlas has been observed using both a short hex hash and a full
// UUID for the same "card_" prefix, and there is no reason to assume it
// won't vary again. This is only a "does this look like a per-card
// instance id" filter, not a security boundary (that's buildDetection's
// visibility resolution below), so erring permissive here is safe.
const CARD_INSTANCE_ID_PATTERN = /^card_[0-9a-f-]+$/i;
const BATTLEFIELD_SLOT_ID_PATTERN = /^battlefield-marker:battlefield[AB]$/;
const CARDBACK_IMAGE_PATTERN = /cardback-(white|blue)\.png/;

/** RiftAtlas attaches this to every real card instance — see the module header. Exported so card-observer.ts can watch the exact same set of elements without duplicating the literal. */
export const CARD_ANCHOR_SELECTOR = "[data-card-id]";

const KNOWN_DROP_ZONES: ReadonlySet<string> = new Set<string>([
  "hand",
  "base",
  "battlefieldA",
  "battlefieldB",
  "runeArea",
  "legend",
  "champion",
  "trash",
  "chain",
]);

/** Exported for unit testing — this pattern-matching decision is what silently under-detected cards on a real live capture (see the module header), so it's worth testing directly rather than only via the DOM-dependent detectCards() as a whole. */
export function isDetectableInstanceId(id: string): boolean {
  return CARD_INSTANCE_ID_PATTERN.test(id) || BATTLEFIELD_SLOT_ID_PATTERN.test(id);
}

function toDropZone(raw: string | null): DropZone {
  if (raw && KNOWN_DROP_ZONES.has(raw)) return raw as DropZone;
  return "unknown";
}

function toPixelBounds(el: Element): PixelBounds {
  const rect = el.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function imageSrc(img: HTMLImageElement): string {
  return img.currentSrc || img.src;
}

/**
 * Determines which face — front art or cardback — is actually rendered
 * right now, by asking the browser what's really on screen at the card's
 * center point instead of guessing at whatever CSS flip mechanism RiftAtlas
 * uses. Returns undefined (unresolved) rather than guessing whenever we
 * can't be sure, e.g. the slot is scrolled off-screen.
 *
 * Also returns undefined whenever the card is currently under the mouse.
 * RiftAtlas appears to let the owning player hover a face-down card to peek
 * at it — a reasonable in-client convenience for them, but that reveal must
 * never leak into what we report as "public," regardless of whose card it
 * is: this data ultimately feeds a viewer/overlay a remote audience sees,
 * not just the local player. This is mechanism-agnostic (works no matter
 * how RiftAtlas implements the peek) at the cost of a harmless transient
 * "unknown" blip on already-public cards while they happen to be hovered —
 * the next debounced re-scan corrects it once the mouse moves on.
 */
function resolveVisibleFace(anchor: Element, faces: HTMLImageElement[]): HTMLImageElement | undefined {
  if (anchor.matches(":hover")) return undefined;
  if (faces.length === 0) return undefined;
  if (faces.length === 1) return faces[0];

  const rect = anchor.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return undefined;

  const hit = document.elementFromPoint(cx, cy);
  if (!hit) return undefined;

  return faces.find((img) => img === hit || img.contains(hit) || hit.contains(img));
}

function parseCardId(imageUrl: string): string | undefined {
  return imageUrl.match(CARD_IMAGE_URL_PATTERN)?.[1];
}

function nearestOwner(el: Element): Owner {
  let current: Element | null = el;
  while (current) {
    const explicit = current.getAttribute("data-zone-owner");
    if (explicit === "self" || explicit === "opponent") return explicit;
    const label = current.getAttribute("aria-label");
    if (label) {
      if (/^your /i.test(label)) return "self";
      if (/^opponent/i.test(label)) return "opponent";
    }
    current = current.parentElement;
  }
  return "unknown";
}

// How many ancestors outward from the anchor to check for a rotation
// transform before giving up (0 = anchor only). See rotation.ts's module
// header for the DOM assumption this exists to accommodate — different
// zones have been observed carrying rotation at different hop counts (0
// for a hand-fan tilt, 3 for a tapped battlefield unit), so this is
// deliberately generous rather than hardcoded to one exact depth.
const MAX_ROTATION_SEARCH_DEPTH = 6;

/**
 * Searches outward from `anchor` — the anchor itself, then each ancestor in
 * turn — for the first element that actually carries a rotation-relevant
 * transform. Stops at the first one found; never composes/accumulates
 * transforms across multiple ancestors.
 */
function resolveRotation(anchor: Element): number {
  let current: Element | null = anchor;
  let depth = 0;
  while (current && depth <= MAX_ROTATION_SEARCH_DEPTH) {
    const style = getComputedStyle(current);
    const rotation = resolveElementRotationDeg({
      computedRotate: style.rotate || "none",
      inlineTransform: (current as HTMLElement).style?.transform || "",
      computedTransform: style.transform,
    });
    if (rotation !== undefined) return rotation;
    current = current.parentElement;
    depth++;
  }
  return 0;
}

// Not identity-sensitive (it's a rendering hint, not card data), so this is
// read regardless of visibility — unlike cardId/name/imageUrl below.
function parseZIndexHint(el: Element): number | undefined {
  const raw = getComputedStyle(el).zIndex;
  if (raw === "auto") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildDetection(anchor: HTMLElement): CardDetection {
  const faces = Array.from(anchor.querySelectorAll<HTMLImageElement>("img[src]"));
  const visibleFace = resolveVisibleFace(anchor, faces);

  let visibility: Visibility = "unknown";
  let cardId: string | undefined;
  let name: string | undefined;
  let imageUrl: string | undefined;
  if (visibleFace) {
    const src = imageSrc(visibleFace);
    if (CARDBACK_IMAGE_PATTERN.test(src)) {
      visibility = "hidden";
    } else {
      visibility = "public";
      imageUrl = src;
      cardId = parseCardId(src);
      name = visibleFace.alt.trim() || undefined;
    }
  }

  return {
    instanceId: anchor.getAttribute("data-card-id") ?? "",
    cardId,
    name,
    imageUrl,
    visibility,
    dropZone: toDropZone(anchor.getAttribute("data-drop-zone")),
    owner: nearestOwner(anchor),
    rotationDeg: resolveRotation(anchor),
    landscape: anchor.getAttribute("data-preview-landscape") === "true",
    zIndexHint: parseZIndexHint(anchor),
    bounds: toPixelBounds(anchor),
    element: anchor,
  };
}

/**
 * Finds every card-like element under `root` and returns one CardDetection
 * per unique instanceId. RiftAtlas renders more than one element per card
 * instance sharing the same data-card-id (e.g. a "preview anchor" div and
 * an interactive button) — this dedupes to one, preferring whichever
 * candidate resolved to "public" over "hidden"/"unknown" duplicates.
 */
export function detectCards(root: ParentNode = document): CardDetection[] {
  const byInstanceId = new Map<string, CardDetection>();

  root.querySelectorAll<HTMLElement>(CARD_ANCHOR_SELECTOR).forEach((el) => {
    const instanceId = el.getAttribute("data-card-id");
    if (!instanceId || !isDetectableInstanceId(instanceId)) return;

    const detection = buildDetection(el);
    const existing = byInstanceId.get(instanceId);
    if (!existing || (existing.visibility !== "public" && detection.visibility === "public")) {
      byInstanceId.set(instanceId, detection);
    }
  });

  return Array.from(byInstanceId.values());
}
