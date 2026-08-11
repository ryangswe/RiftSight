// The shared, DOM-level hover/preview controller — the exact card-resolution
// and popup-rendering behavior the real Twitch viewer overlay uses, extracted
// out of twitch-extension/src/viewer/main.ts so that both the production
// viewer AND the riftsight.gg website demo drive the identical loop instead
// of maintaining two copies that could drift apart.
//
// This is the ONE DOM-dependent module in overlay-core (everything else here
// is pure/testable in plain Node). It deliberately knows nothing about how
// state arrives — no relay, no WebSocket, no Twitch APIs, no delay buffer,
// no diagnostics. The host feeds it cards via setCards() and wires input to
// handlePoint()/previewCard()/hide(); the controller owns geometry
// resolution (against each card's true rotated quad), the popup element, and
// positioning. Its hidden-information guarantees come entirely from the
// shared primitives it calls (cardPopupContentFor / the wire schema), so a
// non-public card never renders identity here either.

import type { NormalizedBounds, OverlayCard } from "@riftsight/protocol";
import {
  FULL_FRAME_SOURCE_REGION,
  mapBoundsToSourceRegion,
  mapSizeToSourceRegion,
  type SourceRegion,
} from "./source-region.js";
import {
  computeCardQuad,
  computeRectQuad,
  resolveHoveredCard,
  type CardQuad,
  type HoverCandidate,
} from "./quad.js";
import { computeHitboxStyle, computeTooltipPosition, hitboxClassName, type Rect } from "./render.js";
import { cardPopupContentFor, computeTooltipMaxSize, tooltipContentFor } from "./tooltip.js";

export interface CardHoverConfig {
  /** Where the game frame sits within the stage (broadcaster-calibrated in production; usually fullFrame for a demo screenshot). */
  sourceRegion: SourceRegion;
  /** Popup size multiplier applied to the portrait/landscape base sizes. */
  tooltipScale: number;
  /** Draw visible outlines around every card hitbox (dev/alignment only). */
  debugOutlines: boolean;
  /** Master kill-switch — when false, nothing resolves and no popup shows. */
  overlayEnabled: boolean;
}

const DEFAULT_CONFIG: CardHoverConfig = {
  sourceRegion: FULL_FRAME_SOURCE_REGION,
  tooltipScale: 1,
  debugOutlines: false,
  overlayEnabled: true,
};

export interface CardHoverOverlayOptions {
  /**
   * The overlay layer. MUST be a positioned element (position: relative or
   * absolute) — the popup and debug hitboxes are positioned in its local
   * pixel space. In the Twitch viewer it fills the iframe (inset: 0), so
   * stage-local coordinates coincide with client coordinates; in the demo
   * it's the screenshot box.
   */
  stage: HTMLElement;
  /**
   * The popup element. MUST be a descendant of `stage` and
   * position: absolute, so its left/top are interpreted in stage-local
   * pixels. The controller only sets its children, display, left and top.
   */
  tooltip: HTMLElement;
  /** Element whose CSS cursor becomes "pointer" over a resolvable card (default: stage). */
  cursorTarget?: HTMLElement;
  /** When true, an extra debug line (zone/owner/id) is appended to the popup while debugOutlines is on. Default true, matching the production viewer. */
  showDebugLine?: boolean;
}

/**
 * Reduces a card's true rotated quad to the axis-aligned rect
 * computeTooltipPosition expects (it only needs a placement anchor).
 */
function quadToRect(quad: CardQuad): Rect {
  const xs = quad.points.map((p) => p.x);
  const ys = quad.points.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export class CardHoverOverlay {
  private readonly stage: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly cursorTarget: HTMLElement;
  private readonly showDebugLine: boolean;
  /** Debug outlines live in their own layer so re-rendering them never disturbs the tooltip, which is also a child of the stage. */
  private readonly hitboxLayer: HTMLElement;

  private config: CardHoverConfig = { ...DEFAULT_CONFIG };
  private cards: OverlayCard[] = [];
  private blockingRegion: NormalizedBounds | undefined;

  // Hover-candidate cache — rebuilding every card's rotated quad is only
  // needed when the cards/region change or the stage resizes, never merely
  // because the pointer moved (see the production viewer's rationale).
  private candidatesDirty = true;
  private cachedCandidates: HoverCandidate[] = [];
  private cachedBlockingQuad: CardQuad | undefined;
  private cachedStageWidth = 0;
  private cachedStageHeight = 0;

  private currentlyShownInstanceId: string | undefined;
  private detachInput: (() => void) | undefined;

  constructor(options: CardHoverOverlayOptions) {
    this.stage = options.stage;
    this.tooltip = options.tooltip;
    this.cursorTarget = options.cursorTarget ?? options.stage;
    this.showDebugLine = options.showDebugLine ?? true;

    this.hitboxLayer = this.stage.ownerDocument.createElement("div");
    this.hitboxLayer.className = "hitbox-layer";
    this.hitboxLayer.style.position = "absolute";
    this.hitboxLayer.style.inset = "0";
    this.hitboxLayer.style.pointerEvents = "none";
    // Insert the debug layer behind the tooltip if the tooltip is already in
    // the stage, otherwise just append it.
    this.stage.insertBefore(this.hitboxLayer, this.tooltip.parentElement === this.stage ? this.tooltip : null);
  }

  setConfig(partial: Partial<CardHoverConfig>): void {
    const before = this.config;
    this.config = { ...before, ...partial };
    // sourceRegion change invalidates every cached quad.
    if (partial.sourceRegion && partial.sourceRegion !== before.sourceRegion) this.candidatesDirty = true;
    if (this.config.overlayEnabled === false) this.hide();
    this.renderDebugOutlines();
  }

  setCards(cards: OverlayCard[], blockingRegion?: NormalizedBounds): void {
    this.cards = cards;
    this.blockingRegion = blockingRegion;
    this.candidatesDirty = true;
    // A card that was being previewed may no longer exist / be resolvable.
    if (this.currentlyShownInstanceId && !cards.some((c) => c.instanceId === this.currentlyShownInstanceId)) {
      this.hide();
    }
    this.renderDebugOutlines();
  }

  /** Resolve whatever card is under a client-space point (or null). */
  resolveAt(clientX: number, clientY: number): OverlayCard | null {
    const stageRect = this.stage.getBoundingClientRect();
    if (!this.pointWithinStage(clientX, clientY, stageRect)) return null;
    const stageSize = { width: stageRect.width, height: stageRect.height };
    const point = { x: clientX - stageRect.left, y: clientY - stageRect.top };
    return resolveHoveredCard(point, this.getHoverCandidates(stageSize), this.getBlockingQuad(stageSize));
  }

  /**
   * The single source of hover state (shared by mouse hover and touch tap):
   * resolve the point against every card's true rotated quad and show/hide
   * the popup for whichever card — if any — is under it and highest-stacked.
   */
  handlePoint(clientX: number, clientY: number): void {
    const stageRect = this.stage.getBoundingClientRect();
    if (
      !this.config.overlayEnabled ||
      !this.pointWithinStage(clientX, clientY, stageRect) ||
      stageRect.width === 0 ||
      stageRect.height === 0
    ) {
      this.hide();
      return;
    }

    const stageSize = { width: stageRect.width, height: stageRect.height };
    const point = { x: clientX - stageRect.left, y: clientY - stageRect.top };
    const candidates = this.getHoverCandidates(stageSize);
    const resolved = resolveHoveredCard(point, candidates, this.getBlockingQuad(stageSize));

    // Skip re-showing the same card — handlePoint runs on every mousemove
    // pixel, so without this a still cursor would recreate the <img> forever.
    if (resolved?.instanceId !== this.currentlyShownInstanceId) {
      if (resolved) {
        const candidate = candidates.find((c) => c.card.instanceId === resolved.instanceId)!;
        this.showTooltipFor(resolved, quadToRect(candidate.quad));
      } else {
        this.hide();
      }
    }
    this.cursorTarget.style.cursor = resolved ? "pointer" : "";
  }

  /** Show the preview for a specific card by id (keyboard focus / programmatic). Always (re)shows, bypassing the move-dedup. */
  previewCard(instanceId: string): void {
    const stageRect = this.stage.getBoundingClientRect();
    if (!this.config.overlayEnabled || stageRect.width === 0 || stageRect.height === 0) return;
    const stageSize = { width: stageRect.width, height: stageRect.height };
    const candidate = this.getHoverCandidates(stageSize).find((c) => c.card.instanceId === instanceId);
    if (!candidate) {
      this.hide();
      return;
    }
    this.showTooltipFor(candidate.card, quadToRect(candidate.quad));
  }

  hide(): void {
    this.tooltip.style.display = "none";
    this.currentlyShownInstanceId = undefined;
    this.cursorTarget.style.cursor = "";
  }

  /** Convenience: wire mouse hover (mousemove/mouseleave). Returns a detach fn; also tracked for destroy(). */
  attachMouseHover(doc: Document = this.stage.ownerDocument): () => void {
    const onMove = (event: MouseEvent) => this.handlePoint(event.clientX, event.clientY);
    const onLeave = () => this.hide();
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseleave", onLeave);
    const detach = () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseleave", onLeave);
    };
    this.detachInput = detach;
    return detach;
  }

  destroy(): void {
    this.detachInput?.();
    this.detachInput = undefined;
    this.hitboxLayer.remove();
    this.hide();
  }

  // ---- internals ----------------------------------------------------------

  private pointWithinStage(clientX: number, clientY: number, rect: DOMRect): boolean {
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  private mapCard(card: OverlayCard): OverlayCard {
    const bounds = mapBoundsToSourceRegion(card.bounds, this.config.sourceRegion);
    const size = mapSizeToSourceRegion({ width: card.localWidth, height: card.localHeight }, this.config.sourceRegion);
    return { ...card, bounds, localWidth: size.width, localHeight: size.height };
  }

  private computeHoverCandidates(stageSize: { width: number; height: number }): HoverCandidate[] {
    return this.cards.map((card) => ({
      card,
      quad: computeCardQuad(this.mapCard(card), stageSize),
      zIndex: card.zIndex ?? 0,
    }));
  }

  private refreshHoverCacheIfNeeded(stageSize: { width: number; height: number }): void {
    if (!this.candidatesDirty && stageSize.width === this.cachedStageWidth && stageSize.height === this.cachedStageHeight) {
      return;
    }
    this.cachedCandidates = this.computeHoverCandidates(stageSize);
    this.cachedBlockingQuad = this.blockingRegion
      ? computeRectQuad(mapBoundsToSourceRegion(this.blockingRegion, this.config.sourceRegion), stageSize)
      : undefined;
    this.cachedStageWidth = stageSize.width;
    this.cachedStageHeight = stageSize.height;
    this.candidatesDirty = false;
  }

  private getHoverCandidates(stageSize: { width: number; height: number }): HoverCandidate[] {
    this.refreshHoverCacheIfNeeded(stageSize);
    return this.cachedCandidates;
  }

  private getBlockingQuad(stageSize: { width: number; height: number }): CardQuad | undefined {
    this.refreshHoverCacheIfNeeded(stageSize);
    return this.cachedBlockingQuad;
  }

  private renderDebugOutlines(): void {
    this.hitboxLayer.replaceChildren();
    if (!this.config.overlayEnabled) return;
    const doc = this.stage.ownerDocument;
    for (const card of this.cards) {
      const box = doc.createElement("div");
      box.className = `${hitboxClassName(card)} ${this.config.debugOutlines ? "debug-outline" : ""}`.trim();
      const style = computeHitboxStyle(this.mapCard(card));
      box.style.position = "absolute";
      box.style.boxSizing = "border-box";
      box.style.pointerEvents = "none";
      box.style.left = style.left;
      box.style.top = style.top;
      box.style.width = style.width;
      box.style.height = style.height;
      box.style.zIndex = style.zIndex;
      box.style.transform = style.transform ?? "";
      box.style.transformOrigin = style.transformOrigin ?? "";
      this.hitboxLayer.appendChild(box);
    }
  }

  private positionTooltipNear(targetRect: Rect): void {
    const stageRect = this.stage.getBoundingClientRect();
    const position = computeTooltipPosition(
      targetRect,
      { width: this.tooltip.offsetWidth, height: this.tooltip.offsetHeight },
      { width: stageRect.width, height: stageRect.height }
    );
    this.tooltip.style.left = `${position.left}px`;
    this.tooltip.style.top = `${position.top}px`;
  }

  private showTooltipFor(card: OverlayCard, targetRect: Rect): void {
    // Hidden/unknown cards get no popup at all — there's nothing safe to
    // show, and even a "Hidden card" label is an unwanted signal.
    if (card.visibility !== "public") {
      this.hide();
      return;
    }

    this.currentlyShownInstanceId = card.instanceId;
    const content = cardPopupContentFor(card);
    const doc = this.stage.ownerDocument;
    this.tooltip.replaceChildren();
    // Battlefield-type (landscape) art gets a larger box — driven by the
    // card's own `landscape` flag, not its zone.
    this.tooltip.classList.toggle("tooltip-battlefield", card.landscape);

    if (content.imageUrl) {
      const img = doc.createElement("img");
      img.src = content.imageUrl;
      img.alt = content.altText;
      img.decoding = "async";
      img.className = "tooltip-art";
      const maxSize = computeTooltipMaxSize(card.landscape, this.config.tooltipScale);
      img.style.width = `${maxSize.maxWidthPx}px`;
      img.style.height = `${maxSize.maxHeightPx}px`;
      img.onerror = () => {
        if (!img.isConnected) return;
        img.replaceWith(this.createFallbackLabel(content.fallbackLabel));
      };
      img.onload = () => {
        if (!img.isConnected) return;
        this.positionTooltipNear(targetRect);
      };
      this.tooltip.appendChild(img);
    } else {
      this.tooltip.appendChild(this.createFallbackLabel(content.fallbackLabel));
    }

    if (this.config.debugOutlines && this.showDebugLine) {
      const debugLine = doc.createElement("div");
      debugLine.className = "tooltip-debug";
      debugLine.textContent = tooltipContentFor(card).lines.join(" · ");
      this.tooltip.appendChild(debugLine);
    }

    this.tooltip.style.display = "block";
    this.positionTooltipNear(targetRect);
  }

  private createFallbackLabel(label: string): HTMLElement {
    const text = this.stage.ownerDocument.createElement("div");
    text.className = "tooltip-fallback";
    text.textContent = label;
    return text;
  }
}
