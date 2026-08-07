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
// are only ever populated when classifyCardVisibility() has positively
// confirmed which face is actually rendered right now.
//
// ALSO CONFIRMED via live DevTools inspection: the two face images are each
// wrapped in a `backface-visibility: hidden` element, and those two wrapper
// siblings share one `transform-style: preserve-3d` parent. That shared
// parent's own `transform` — toggled between an identity matrix and a
// rotateY(180deg) matrix — is RiftAtlas's actual flip state (see
// face-transform.ts for the matrix math). Reading that one CSS property is
// a complete, occlusion-independent replacement for the pixel-sampling this
// module used previously: it depends only on the card's own two children,
// never on what a different, overlapping card is drawn on top of. Verified
// live to agree with the old sampling approach on 14 real face-up cards and
// one genuinely face-down card, with zero disagreements.

import { classifyFaceFacing, type FaceFacing } from "./face-transform.js";
import { composeRotations, resolveElementRotationDeg } from "./rotation.js";
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
// The card currently resolving on the chain (a spell/ability in response to
// which players may react) gets a composite id shaped like
// "chain-plr_<hex>-card_<uuid>-<uuid>" — live-captured, real example:
// "chain-plr_7a07bb13-card_7db9227a-a606-430b-98b5-ec280c610b34-d526be66-1952-41c9-9a91-2887d66d7f36".
// The real card_<uuid> is recoverable from the *image* src via
// CARD_IMAGE_URL_PATTERN regardless, so this only needs to recognize the
// shape, not fully parse it — deliberately just a prefix check (not
// anchored at the end) for the same reason CARD_INSTANCE_ID_PATTERN is
// permissive on shape: this isn't a security boundary, only "does this look
// like a chain-zone instance id."
const CHAIN_INSTANCE_ID_PATTERN = /^chain-/i;
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
  return CARD_INSTANCE_ID_PATTERN.test(id) || BATTLEFIELD_SLOT_ID_PATTERN.test(id) || CHAIN_INSTANCE_ID_PATTERN.test(id);
}

/**
 * Every other zone is read straight off `data-drop-zone` — but a
 * live capture confirmed the chain card carries no `data-drop-zone`
 * attribute at all (nor does any ancestor), so its own instance id
 * (see CHAIN_INSTANCE_ID_PATTERN) is the only signal available for it.
 * Exported for unit testing, same rationale as isDetectableInstanceId.
 */
export function toDropZone(raw: string | null, instanceId: string): DropZone {
  if (raw && KNOWN_DROP_ZONES.has(raw)) return raw as DropZone;
  if (CHAIN_INSTANCE_ID_PATTERN.test(instanceId)) return "chain";
  return "unknown";
}

function toPixelBounds(el: Element): PixelBounds {
  const rect = el.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function imageSrc(img: HTMLImageElement): string {
  return img.currentSrc || img.src;
}

function parseCardId(imageUrl: string): string | undefined {
  return imageUrl.match(CARD_IMAGE_URL_PATTERN)?.[1];
}

/**
 * RiftAtlas renders different UI contexts (hand, base, chain, ...) at
 * different resolution tiers of the same asset — "small-v2" (384×536 native)
 * and "original" (1030×1438 native, live-confirmed) are the two seen so far
 * (see CARD_IMAGE_URL_PATTERN). Which tier a given card slot happens to use
 * is a RiftAtlas layout decision, not something meaningful to preserve:
 * RiftSight's tooltip always wants sharper art than the smallest on-board
 * slots render at.
 *
 * Deliberately NOT the raw, uncapped "original" source, though — that art is
 * fetched directly by every viewer's own browser straight from RiftAtlas's
 * CDN (never through RiftSight's own infrastructure, by design), so an
 * earlier version of this function that stripped RiftAtlas's own Cloudflare
 * Image Resizing proxy entirely was needlessly costly to a third party's
 * infrastructure RiftSight doesn't control or pay for: full native
 * resolution is far more than the tooltip's own largest configured size
 * (roughly 400×500 CSS px) ever actually displays, even at 2x device pixel
 * ratio. This instead rewrites the resize proxy's own `width=` parameter to
 * a fixed 640 — comfortably covering that largest display size at 2x, live-
 * confirmed to load successfully against the "original" tier — while still
 * routing through Cloudflare's resizing (keeping its real compression and
 * format negotiation, `quality=…,format=auto`) rather than bypassing it.
 * 640 was chosen over the width already seen to fail (256) specifically
 * because it's both confirmed-working and adequate for the tooltip's actual
 * max render size — not because every value between the two is assumed
 * safe.
 *
 * Rewrites the real captured URL (same domain, same query string, same
 * everything else) rather than reconstructing one from the parsed cardId —
 * safer, since it never has to know or guess the asset host's actual base
 * path. A URL with no recognized tier segment at all is returned unchanged;
 * a URL with no resize-proxy `width=` parameter at all (not seen in any real
 * capture so far) falls back to the tier's uncapped native resolution rather
 * than guessing at how to construct a resize-proxy segment from scratch.
 */
export function upgradeToOriginalResolution(imageUrl: string): string {
  return imageUrl.replace(/width=\d+/, "width=640").replace("/cards/small-v2/", "/cards/original/");
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

// How many ancestors outward from the anchor to check before giving up (0 =
// anchor only). Shared by resolveAncestorTraits' rotation and z-index
// lookups below — different zones have been observed carrying each at
// different hop counts (0 for a hand-fan tilt's rotation, 3 for a tapped
// battlefield unit's), so this is deliberately generous rather than
// hardcoded to one exact depth.
const MAX_ANCESTOR_SEARCH_DEPTH = 6;

interface AncestorTraits {
  rotationDeg: number;
  zIndexHint: number | undefined;
}

/**
 * Rotation and z-index both need to inspect the same walk outward from
 * `anchor` — the anchor itself, then each ancestor in turn, up to
 * MAX_ANCESTOR_SEARCH_DEPTH — so this does that walk once and extracts both
 * from the same per-level getComputedStyle() call, rather than what used to
 * be two independent functions each separately calling getComputedStyle()
 * on every one of the same ancestors. Each trait keeps its own original,
 * independent logic; only the walk itself is shared:
 *
 * - Rotation collects every ancestor's own contribution and composes them
 *   (composeRotations) rather than stopping at the first — multiple
 *   ancestors *can* each carry a real rotation at once, confirmed via a
 *   live capture of an opponent-side landscape card, whose zone wrapper
 *   carries its own standalone `rotate: 180deg` (a perspective correction)
 *   one level nearer the anchor than the card's own `rotate(90deg)`; see
 *   rotation.ts's module header for the full story.
 *
 * - Z-index stops at the first real (non-"auto") value found and keeps it —
 *   unlike rotation, this one is *not* meant to compose. CONFIRMED via live
 *   capture: RiftAtlas sets its real, meaningful z-index on an ancestor —
 *   the same "position-transition wrapper" where a card's own rotation is
 *   also found — never on the anchor itself, which always reports "auto".
 *   Reading only the anchor's own z-index (the old behavior, before this
 *   walk existed at all) therefore always returned undefined for every
 *   hand/base card, silently forcing the viewer's stack-order comparison to
 *   fall back to array order for all of them — coincidentally correct for
 *   hand (real z-index there also increases left-to-right) but exactly
 *   inverted for base zone (real z-index *decreases* left-to-right, leftmost
 *   on top), which is why base-zone hover was so much more broken than
 *   hand's before that fix.
 */
function resolveAncestorTraits(anchor: Element): AncestorTraits {
  let current: Element | null = anchor;
  let depth = 0;
  const rotationContributions: number[] = [];
  let zIndexHint: number | undefined;

  while (current && depth <= MAX_ANCESTOR_SEARCH_DEPTH) {
    const style = getComputedStyle(current);

    const rotation = resolveElementRotationDeg({
      computedRotate: style.rotate || "none",
      inlineTransform: (current as HTMLElement).style?.transform || "",
      computedTransform: style.transform,
    });
    if (rotation !== undefined) rotationContributions.push(rotation);

    if (zIndexHint === undefined && style.zIndex !== "auto") {
      const parsed = Number.parseInt(style.zIndex, 10);
      if (!Number.isNaN(parsed)) zIndexHint = parsed;
    }

    current = current.parentElement;
    depth++;
  }

  return { rotationDeg: composeRotations(rotationContributions), zIndexHint };
}

interface VisibilityClassification {
  visibility: Visibility;
  /** The specific front-face <img> to read cardId/name/imageUrl from — only set when visibility is "public". */
  visibleFace: HTMLImageElement | undefined;
}

/**
 * Walks upward from a face `<img>` to the nearest ancestor with computed
 * `backface-visibility: hidden` — the per-face 3D-flip wrapper (see
 * face-transform.ts's module header). Matched by the actual computed CSS
 * property rather than a specific class name, since that property is
 * what RiftAtlas's own flip effect structurally depends on to work at
 * all, and so is far less likely to silently change than an internal
 * utility-class name would be.
 */
function findBackfaceHiddenAncestor(el: Element, maxHops = 6): Element | undefined {
  let current: Element | null = el;
  for (let depth = 0; depth <= maxHops && current; depth++) {
    if (getComputedStyle(current).backfaceVisibility === "hidden") return current;
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Resolves which face is toward the camera by reading the shared
 * preserve-3d parent's own `transform` — see this module's header and
 * face-transform.ts. Returns "unsupported" (never guesses) whenever the
 * expected structure isn't found: either wrapper missing, or the two
 * wrappers don't share a single parent.
 */
function resolveFaceFacing(frontFace: HTMLImageElement, backFace: HTMLImageElement): FaceFacing {
  const frontWrapper = findBackfaceHiddenAncestor(frontFace);
  const backWrapper = findBackfaceHiddenAncestor(backFace);
  if (!frontWrapper || !backWrapper) return "unsupported";

  const parent = frontWrapper.parentElement;
  if (!parent || parent !== backWrapper.parentElement) return "unsupported";

  return classifyFaceFacing(getComputedStyle(parent).transform);
}

/**
 * Determines which face — front art or cardback — is actually rendered
 * right now, by reading the shared 3D-flip container's own `transform`
 * (see face-transform.ts) rather than sampling pixels: this depends only
 * on the card's own two children, never on what a different, overlapping
 * card is drawn on top of, so a mostly-covered-but-genuinely-face-up card
 * in a dense hand is no longer at risk of falling to "unknown" purely
 * because a neighbor covers most of its area.
 *
 * Returns "unknown" (no visibleFace) whenever the evidence is anything
 * other than a clean front/back verdict — a mid-flip-animation frame, a
 * missing wrapper, or a structure this module doesn't recognize — never
 * guesses "public".
 *
 * Also returns "unknown" whenever the card is currently under the mouse.
 * RiftAtlas appears to let the owning player hover a face-down card to
 * peek at it — a reasonable in-client convenience for them, but that
 * reveal must never leak into what we report as "public," regardless of
 * whose card it is: this data ultimately feeds a viewer/overlay a remote
 * audience sees, not just the local player. This is mechanism-agnostic
 * (works no matter how RiftAtlas implements the peek) at the cost of a
 * harmless transient "unknown" blip on already-public cards while
 * they're hovered — the next debounced re-scan corrects it once the
 * mouse moves on.
 */
function classifyCardVisibility(anchor: HTMLElement, faces: HTMLImageElement[]): VisibilityClassification {
  if (anchor.matches(":hover")) return { visibility: "unknown", visibleFace: undefined };
  if (faces.length === 0) return { visibility: "unknown", visibleFace: undefined };

  // Only one face element exists at all (no dual front/cardback flip
  // structure for this card type) — nothing to disambiguate.
  if (faces.length === 1) {
    const only = faces[0]!;
    const isCardback = CARDBACK_IMAGE_PATTERN.test(imageSrc(only));
    return { visibility: isCardback ? "hidden" : "public", visibleFace: isCardback ? undefined : only };
  }

  const frontFace = faces.find((img) => !CARDBACK_IMAGE_PATTERN.test(imageSrc(img)));
  const backFace = faces.find((img) => CARDBACK_IMAGE_PATTERN.test(imageSrc(img)));
  if (!frontFace || !backFace) return { visibility: "unknown", visibleFace: undefined };

  const facing = resolveFaceFacing(frontFace, backFace);
  if (facing === "front") return { visibility: "public", visibleFace: frontFace };
  if (facing === "back") return { visibility: "hidden", visibleFace: undefined };
  return { visibility: "unknown", visibleFace: undefined }; // "intermediate" or "unsupported"
}

function buildDetection(anchor: HTMLElement): CardDetection {
  const instanceId = anchor.getAttribute("data-card-id") ?? "";
  const faces = Array.from(anchor.querySelectorAll<HTMLImageElement>("img[src]"));
  const { rotationDeg, zIndexHint } = resolveAncestorTraits(anchor);
  const { visibility, visibleFace } = classifyCardVisibility(anchor, faces);

  let cardId: string | undefined;
  let name: string | undefined;
  let imageUrl: string | undefined;
  if (visibility === "public" && visibleFace) {
    const src = imageSrc(visibleFace);
    imageUrl = upgradeToOriginalResolution(src);
    cardId = parseCardId(src);
    name = visibleFace.alt.trim() || undefined;
  }

  return {
    instanceId,
    cardId,
    name,
    imageUrl,
    visibility,
    dropZone: toDropZone(anchor.getAttribute("data-drop-zone"), instanceId),
    owner: nearestOwner(anchor),
    rotationDeg,
    landscape: anchor.getAttribute("data-preview-landscape") === "true",
    zIndexHint,
    bounds: toPixelBounds(anchor),
    // offsetWidth/offsetHeight are layout-space (border-box) dimensions,
    // unaffected by any CSS transform on the anchor or an ancestor — the
    // card's true unrotated size, unlike bounds' rotation-inflated AABB.
    localWidth: anchor.offsetWidth,
    localHeight: anchor.offsetHeight,
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
