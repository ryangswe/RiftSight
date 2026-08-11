// riftsight.gg "See it in action" interactive demo.
//
// This drives the SAME overlay-core CardHoverOverlay the production Twitch
// viewer uses — hover resolution against each card's true rotated quad,
// visibility-gated previews, portrait/landscape sizing, popup positioning —
// against a STATIC bundled fixture. It never connects to the relay, Twitch,
// or any WebSocket/API; its only network fetch is the local fixture JSON and
// the card images the fixture references.
import {
  CardHoverOverlay,
  FULL_FRAME_SOURCE_REGION,
  computeHitboxStyle,
  mapBoundsToSourceRegion,
  mapSizeToSourceRegion,
  parseSourceRegion,
  type SourceRegion,
} from "@riftsight/overlay-core";
import type { OverlayCard, OverlayState } from "@riftsight/protocol";

interface DemoConfig {
  state?: string;
  board?: string;
  sourceRegion?: unknown;
  tooltipScale?: number | null;
}

const cfg: DemoConfig =
  (window as unknown as { RIFTSIGHT_CONFIG?: { interactiveDemo?: DemoConfig } }).RIFTSIGHT_CONFIG?.interactiveDemo ?? {};
const STATE_URL = cfg.state ?? "./demo/demo-state.json";
const SOURCE_REGION: SourceRegion = cfg.sourceRegion ? parseSourceRegion(cfg.sourceRegion) : FULL_FRAME_SOURCE_REGION;

const section = document.getElementById("demo");
const stage = document.getElementById("rs-demo-stage");
const tooltip = document.getElementById("rs-demo-tooltip");
const a11yLayer = document.getElementById("rs-demo-a11y");
const hint = document.getElementById("rs-demo-hint");

// Without the required elements there's nothing to enhance — the static
// board screenshot in the markup stands on its own (graceful no-JS/degraded
// behavior).
if (section && stage && tooltip && a11yLayer) {
  // Below the fold — only spin up when the section is near the viewport, to
  // keep the heavier fixture/image fetches off the initial load. Uses an
  // IntersectionObserver as the primary trigger with a getBoundingClientRect
  // fallback on scroll/resize, so it still initializes in environments where
  // IntersectionObserver is unreliable.
  let started = false;
  const nearViewport = (): boolean => {
    const r = section.getBoundingClientRect();
    return r.top < window.innerHeight + 300 && r.bottom > -300;
  };
  const cleanup: Array<() => void> = [];
  const maybeStart = (): void => {
    if (started || !nearViewport()) return;
    started = true;
    for (const off of cleanup) off();
    void start(section, stage, tooltip, a11yLayer, hint);
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) maybeStart();
    }, { rootMargin: "300px" });
    io.observe(section);
    cleanup.push(() => io.disconnect());
  }
  const onScroll = () => maybeStart();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  cleanup.push(() => window.removeEventListener("scroll", onScroll));
  cleanup.push(() => window.removeEventListener("resize", onScroll));
  maybeStart(); // immediate check for when the section is already in view
}

/** Popup size relative to the demo stage — the production base sizes (320–500px) assume a full 1080p stream, far larger than this section. */
function scaleForStage(stageWidth: number): number {
  return Math.min(Math.max(stageWidth / 900, 0.42), 1);
}

async function start(
  section: HTMLElement,
  stage: HTMLElement,
  tooltip: HTMLElement,
  a11yLayer: HTMLElement,
  hint: HTMLElement | null
): Promise<void> {
  let state: OverlayState;
  try {
    const res = await fetch(STATE_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = (await res.json()) as OverlayState;
    if (!state || !Array.isArray(state.cards)) throw new Error("fixture has no cards[]");
  } catch (err) {
    // Leave the static board in place; log for development only.
    console.warn("[riftsight-demo] could not load demo fixture — leaving the static board.", err);
    return;
  }

  const cards = state.cards as OverlayCard[];
  section.dataset["demoReady"] = "true";

  // Board screenshot is config-driven; the markup carries a sensible default
  // so a no-JS visitor still sees the board.
  const boardImg = document.getElementById("rs-demo-board") as HTMLImageElement | null;
  if (boardImg && cfg.board) boardImg.setAttribute("src", cfg.board);

  const overlay = new CardHoverOverlay({ stage, tooltip });
  overlay.setConfig({
    sourceRegion: SOURCE_REGION,
    tooltipScale: cfg.tooltipScale ?? scaleForStage(stage.getBoundingClientRect().width),
    debugOutlines: false,
    overlayEnabled: true,
  });
  overlay.setCards(cards, state.blockingRegion);

  // Warm the cache for public card art so the first hover has no visible
  // delay; warn (dev only) about a public card missing its image mapping.
  const preloaded = new Set<string>();
  for (const card of cards) {
    if (card.visibility !== "public") continue;
    if (!card.imageUrl) {
      console.warn(`[riftsight-demo] public card ${card.instanceId} has no imageUrl — it will show a text fallback.`);
      continue;
    }
    if (preloaded.has(card.imageUrl)) continue;
    preloaded.add(card.imageUrl);
    const img = new Image();
    img.decoding = "async";
    img.src = card.imageUrl;
  }

  // Keep the popup sized to the stage as it responsively resizes.
  if ("ResizeObserver" in window) {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => overlay.setConfig({ tooltipScale: cfg.tooltipScale ?? scaleForStage(stage.getBoundingClientRect().width) }));
    });
    ro.observe(stage);
  }

  const hoverCapable = window.matchMedia("(hover: hover)").matches;

  // Desktop: natural pointer hover (production behavior).
  if (hoverCapable) overlay.attachMouseHover();

  // Tap: works for touch (and is a harmless no-op duplicate of hover on
  // desktop) — tapping a card previews it, tapping empty space dismisses.
  stage.addEventListener("click", (event) => {
    dismissHint();
    overlay.handlePoint(event.clientX, event.clientY);
  });

  // Touch only: a tap anywhere outside the stage dismisses the preview.
  if (!hoverCapable) {
    document.addEventListener("click", (event) => {
      if (!stage.contains(event.target as Node)) overlay.hide();
    });
    if (hint) hint.textContent = "Tap a visible card to preview it";
  }

  buildAccessibleTargets(cards, overlay, a11yLayer);
  setupHint(stage, hint, cards, overlay);

  // Dev-only alignment aid: ?demoDebug=1 draws the hitbox outlines over the
  // board so you can confirm every card lines up after swapping in a real
  // screenshot + fixture. Not exposed anywhere in the normal UI.
  if (new URLSearchParams(window.location.search).has("demoDebug")) {
    overlay.setConfig({ debugOutlines: true });
    console.info("[riftsight-demo] debug outlines on:", cards.length, "cards");
  }
}

/**
 * Focusable, screen-reader-labelled targets for each PUBLIC card (hidden
 * cards get none — they aren't interactive in production either). They are
 * pointer-events: none, so mouse/touch still go through the geometry
 * resolver on the stage; they exist purely for keyboard/AT users. Positioned
 * with the exact same computeHitboxStyle the debug outlines use, including
 * rotation, so focus rings sit on the real card shape.
 */
function buildAccessibleTargets(cards: OverlayCard[], overlay: CardHoverOverlay, layer: HTMLElement): void {
  layer.replaceChildren();
  for (const card of cards) {
    if (card.visibility !== "public") continue;
    const mapped: OverlayCard = {
      ...card,
      bounds: mapBoundsToSourceRegion(card.bounds, SOURCE_REGION),
      ...mappedSize(card),
    };
    const style = computeHitboxStyle(mapped);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rs-demo-target";
    btn.setAttribute("aria-label", `Preview ${card.name ?? card.cardId ?? "card"}`);
    btn.style.left = style.left;
    btn.style.top = style.top;
    btn.style.width = style.width;
    btn.style.height = style.height;
    btn.style.transform = style.transform ?? "";
    btn.style.transformOrigin = style.transformOrigin ?? "";
    btn.addEventListener("focus", () => {
      dismissHint();
      overlay.previewCard(card.instanceId);
    });
    btn.addEventListener("blur", () => overlay.hide());
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        overlay.hide();
        btn.blur();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        overlay.previewCard(card.instanceId);
      }
    });
    layer.appendChild(btn);
  }
}

function mappedSize(card: OverlayCard): { localWidth: number; localHeight: number } {
  const size = mapSizeToSourceRegion({ width: card.localWidth, height: card.localHeight }, SOURCE_REGION);
  return { localWidth: size.width, localHeight: size.height };
}

// ---- first-load affordance ------------------------------------------------

let hintDismissed = false;
let dismissHintImpl: () => void = () => {};
function dismissHint(): void {
  dismissHintImpl();
}

function setupHint(stage: HTMLElement, hint: HTMLElement | null, cards: OverlayCard[], overlay: CardHoverOverlay): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A single subtle pulse on one obvious visible card, so a visitor realizes
  // the board is interactive — removed on first interaction or after a beat.
  let pulse: HTMLElement | undefined;
  const firstPublic = cards.find((c) => c.visibility === "public" && !c.rotation);
  if (firstPublic && !reduceMotion) {
    const mapped: OverlayCard = { ...firstPublic, bounds: mapBoundsToSourceRegion(firstPublic.bounds, SOURCE_REGION), ...mappedSize(firstPublic) };
    const style = computeHitboxStyle(mapped);
    pulse = document.createElement("div");
    pulse.className = "rs-demo-pulse";
    pulse.style.left = style.left;
    pulse.style.top = style.top;
    pulse.style.width = style.width;
    pulse.style.height = style.height;
    stage.appendChild(pulse);
  }

  if (hint) hint.classList.add("visible");

  dismissHintImpl = () => {
    if (hintDismissed) return;
    hintDismissed = true;
    if (hint) hint.classList.remove("visible");
    pulse?.remove();
  };

  // Any real engagement dismisses it.
  stage.addEventListener("pointerenter", dismissHint, { once: true });
  stage.addEventListener("touchstart", dismissHint, { once: true, passive: true });

  // Auto-retire the pulse after a couple of seconds even without interaction,
  // but keep the text hint until the user actually engages.
  if (pulse) window.setTimeout(() => pulse?.remove(), 4200);
}
