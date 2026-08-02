// RiftSight investigation inventory.
//
// The heuristic scan below (runScan/collectCandidates) is NOT the real card
// detector — it's a throwaway diagnostic that flags anything which *might*
// be a rendered card, used to figure out what signal RiftAtlas actually
// uses. That question is now answered (data-card-id — see card-detector.ts),
// so this panel also exposes a "Detect cards" button that runs the real
// detector and outlines its results, as a sanity check while we keep
// investigating edge cases (rotation, concealed cards, etc).

import { DEFAULT_SESSION_ID } from "@riftsight/protocol";
import { detectCards } from "./card-detector.js";
import { isPublishing, publishedSnapshotCount, startPublishing, stopPublishing } from "./publisher.js";
import type { CardDetection } from "./types.js";
import { LINK_STATUS_LABEL, type LinkState } from "../background/link-state.js";
import { describeStreamerError } from "../background/error-messages.js";

// closed-beta hides the manual session-ID field and the account section
// takes over as the sole "which channel does this publish to" mechanism —
// development and twitch-local-test both keep today's manual field, per
// the milestone spec ("existing tunnel workflow continues to work").
const isClosedBeta = __RIFTSIGHT_MODE__ === "closed-beta";

// Stage 6 open design question, not yet resolved with the relay: in
// closed-beta mode there's no manual session field, so "Start publishing"
// has nothing to send as a session id. Stage 7's authenticated producer
// WebSocket is expected to resolve the real channel server-side from the
// stored producer credential and ignore/override this value — flagging it
// here as an explicit placeholder rather than silently deciding the wire
// contract for that stage.
const CLOSED_BETA_SESSION_PLACEHOLDER = "authenticated-producer";

type Signal = "img-alt" | "bg-image" | "data-card-attr" | "aria-label";

interface InventoryEntry {
  selector: string;
  tag: string;
  signals: Signal[];
  text: string | null;
  imageUrl: string | null;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  rotationDeg: number;
  zIndex: string;
  ancestorPath: string[];
}

interface CanvasEntry {
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface ScanResult {
  entries: InventoryEntry[];
  canvases: CanvasEntry[];
}

// Filters out icons/buttons/avatars; a real card face is comfortably above this.
const MIN_AREA_PX = 900;

function nthOfTypeIndex(el: Element): number {
  let index = 1;
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index++;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

// Best-effort diagnostic selector only — never meant to be hard-coded into
// real detection logic, just so a human can find the element again in
// DevTools while reading the console output.
function cssPath(el: Element, maxDepth = 8): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;
  while (current && current !== document.documentElement && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();
    const idPart = current.id ? `#${current.id}` : "";
    const nth = idPart ? "" : `:nth-of-type(${nthOfTypeIndex(current)})`;
    parts.unshift(`${tag}${idPart}${nth}`);
    current = current.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function ancestorPath(el: Element, levels = 4): string[] {
  const path: string[] = [];
  let current: Element | null = el.parentElement;
  let count = 0;
  while (current && count < levels) {
    const classes = Array.from(current.classList).slice(0, 2).join(".");
    path.push(`${current.tagName.toLowerCase()}${classes ? "." + classes : ""}`);
    current = current.parentElement;
    count++;
  }
  return path;
}

function rotationFromTransform(el: Element): number {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  const match = transform.match(/matrix\(([^)]+)\)/);
  const raw = match?.[1];
  if (!raw) return 0;
  const values = raw.split(",").map((v) => parseFloat(v.trim()));
  const a = values[0];
  const b = values[1];
  if (a === undefined || b === undefined) return 0;
  return Math.round((Math.atan2(b, a) * 180) / Math.PI);
}

function diagnosticAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-") || attr.name === "aria-label" || attr.name === "role" || attr.name === "title") {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

function areaOf(el: Element): number {
  const rect = el.getBoundingClientRect();
  return rect.width * rect.height;
}

function toRect(el: Element): InventoryEntry["rect"] {
  const rect = el.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function buildEntry(el: Element, signals: Signal[]): InventoryEntry {
  const style = getComputedStyle(el);
  const bgImage =
    style.backgroundImage !== "none" ? style.backgroundImage.replace(/^url\(["']?/, "").replace(/["']?\)$/, "") : null;
  const imgSrc = el instanceof HTMLImageElement ? el.currentSrc || el.src : null;
  return {
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    signals,
    text: el.textContent ? el.textContent.trim().slice(0, 80) || null : null,
    imageUrl: imgSrc || bgImage,
    attributes: diagnosticAttributes(el),
    rect: toRect(el),
    rotationDeg: rotationFromTransform(el),
    zIndex: style.zIndex,
    ancestorPath: ancestorPath(el),
  };
}

function hasCardLikeDataAttribute(el: Element): boolean {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-") && /card/i.test(attr.name + attr.value)) {
      return true;
    }
  }
  return false;
}

function collectCandidates(): ScanResult {
  const found = new Map<Element, Set<Signal>>();
  const addSignal = (el: Element, signal: Signal): void => {
    const existing = found.get(el);
    if (existing) {
      existing.add(signal);
    } else {
      found.set(el, new Set([signal]));
    }
  };

  document.querySelectorAll<HTMLImageElement>("img[alt]").forEach((img) => {
    if (img.alt.trim().length > 0 && areaOf(img) >= MIN_AREA_PX) {
      addSignal(img, "img-alt");
    }
  });

  document.querySelectorAll<HTMLElement>("[aria-label], [role='img']").forEach((el) => {
    const label = el.getAttribute("aria-label");
    if (label && label.trim().length > 1 && areaOf(el) >= MIN_AREA_PX) {
      addSignal(el, "aria-label");
    }
  });

  // Single full-DOM pass for the two checks that need every element anyway,
  // rather than running querySelectorAll("*") twice.
  document.querySelectorAll<HTMLElement>("*").forEach((el) => {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    if (getComputedStyle(el).backgroundImage !== "none" && areaOf(el) >= MIN_AREA_PX) {
      addSignal(el, "bg-image");
    }
    if (hasCardLikeDataAttribute(el)) {
      addSignal(el, "data-card-attr");
    }
  });

  const entries: InventoryEntry[] = [];
  found.forEach((signals, el) => entries.push(buildEntry(el, Array.from(signals))));

  const canvases: CanvasEntry[] = Array.from(document.querySelectorAll("canvas")).map((c) => ({
    selector: cssPath(c),
    rect: toRect(c),
  }));

  return { entries, canvases };
}

function summarize(entries: InventoryEntry[]): Record<Signal, number> {
  const counts: Record<Signal, number> = { "img-alt": 0, "bg-image": 0, "data-card-attr": 0, "aria-label": 0 };
  for (const entry of entries) {
    for (const signal of entry.signals) counts[signal]++;
  }
  return counts;
}

let lastResult: ScanResult | null = null;

function runScan(): void {
  const result = collectCandidates();
  lastResult = result;
  const counts = summarize(result.entries);

  console.groupCollapsed(
    `[RiftSight] inventory scan — ${result.entries.length} candidate(s), ${result.canvases.length} canvas element(s)`
  );
  console.table(counts);
  if (result.canvases.length > 0) {
    console.warn(
      "[RiftSight] canvas elements found — if cards render inside these, DOM-based detection will not work and we need a different strategy.",
      result.canvases
    );
  }
  console.log(JSON.stringify(result, null, 2));
  console.groupEnd();

  updatePanel(result, counts);
}

// --- Real card detector sanity check ---------------------------------------
// Runs the actual detector (card-detector.ts) and draws a temporary outline
// over each result so we can visually confirm it's finding the right
// elements. `element` is stripped before logging since it isn't
// serializable — a diagnostic selector stands in for it instead.

const OUTLINE_LAYER_ID = "riftsight-outline-layer";
const OUTLINE_DURATION_MS = 3000;

function serializeDetection(detection: CardDetection): Omit<CardDetection, "element"> & { selector: string } {
  const { element, ...rest } = detection;
  return { ...rest, selector: cssPath(element) };
}

function drawOutlines(detections: CardDetection[]): void {
  document.getElementById(OUTLINE_LAYER_ID)?.remove();

  const layer = document.createElement("div");
  layer.id = OUTLINE_LAYER_ID;
  layer.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";

  // Color-coded by visibility so a redaction bug would be visually obvious:
  // green boxes should only ever carry a cardId, red/gray ones never should.
  const OUTLINE_COLOR: Record<CardDetection["visibility"], string> = {
    public: "#6f6",
    hidden: "#f66",
    unknown: "#999",
  };

  for (const detection of detections) {
    const box = document.createElement("div");
    const { x, y, width, height } = detection.bounds;
    const color = OUTLINE_COLOR[detection.visibility];
    box.style.cssText = [
      "position:fixed",
      `left:${x}px`,
      `top:${y}px`,
      `width:${width}px`,
      `height:${height}px`,
      `border:2px solid ${color}`,
      "box-sizing:border-box",
      "border-radius:4px",
    ].join(";");

    const label = document.createElement("div");
    label.textContent = `${detection.dropZone}/${detection.owner}/${detection.visibility}${detection.cardId ? " " + detection.cardId : ""}`;
    label.style.cssText = `position:absolute;top:-1.2em;left:0;background:#111;color:${color};font:10px monospace;padding:1px 3px;white-space:nowrap;`;
    box.appendChild(label);
    layer.appendChild(box);
  }

  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), OUTLINE_DURATION_MS);
}

function runDetect(): void {
  const detections = detectCards();
  drawOutlines(detections);

  console.groupCollapsed(`[RiftSight] detectCards — ${detections.length} card(s)`);
  console.table(
    detections.map((d) => ({
      instanceId: d.instanceId,
      visibility: d.visibility,
      cardId: d.cardId,
      dropZone: d.dropZone,
      owner: d.owner,
      rotationDeg: d.rotationDeg,
    }))
  );
  console.log(JSON.stringify(detections.map(serializeDetection), null, 2));
  console.groupEnd();

  const panel = ensurePanel();
  const status = panel.querySelector<HTMLDivElement>(`#${PANEL_ID}-detect-status`);
  if (status) {
    status.textContent = `${detections.length} card(s) detected (outlined for ${OUTLINE_DURATION_MS / 1000}s). Full JSON logged to console.`;
  }
}

// Gives you time to move the mouse onto a specific card (and hold still)
// after triggering this, instead of needing to hover and click/press a key
// at the exact same instant — mainly useful for the rotation-diagnostic
// block in card-detector.ts, which only logs for whichever card is
// currently under the cursor at the moment detectCards() runs.
const DELAYED_DETECT_SECONDS = 3;

function runDetectDelayed(): void {
  const panel = ensurePanel();
  const status = panel.querySelector<HTMLDivElement>(`#${PANEL_ID}-detect-status`);
  let remaining = DELAYED_DETECT_SECONDS;

  const tick = (): void => {
    if (status) status.textContent = `Hover the target card now — detecting in ${remaining}s...`;
  };
  tick();

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      runDetect();
      return;
    }
    tick();
  }, 1000);
}

// --- Minimal floating debug panel -----------------------------------------
// Injected once per page load. Deliberately plain-looking so it can never be
// mistaken for part of RiftAtlas itself. Sized and positioned so it never
// covers the play area, and pointer-events are scoped to the panel's own
// box only — it never intercepts clicks on the rest of the page.

const PANEL_ID = "riftsight-inspector-panel";

// --- Account / Twitch-linking section --------------------------------------
// Talks to background/auth.ts exclusively through chrome.runtime messages —
// this content script never touches chrome.storage or the linkId/poll flow
// directly, mirroring how the Live Publishing section below only ever talks
// to the relay connection through background.ts's message handlers.

function buildAccountSection(panel: HTMLElement): void {
  const accountTitle = document.createElement("div");
  accountTitle.textContent = "Account";
  accountTitle.style.cssText = "font-weight:bold;margin-bottom:4px;";
  panel.appendChild(accountTitle);

  const accountStatus = document.createElement("div");
  accountStatus.id = `${PANEL_ID}-account-status`;
  accountStatus.textContent = LINK_STATUS_LABEL["not-connected"];
  accountStatus.style.cssText = "margin-bottom:6px;white-space:pre-wrap;";
  panel.appendChild(accountStatus);

  const connectButton = document.createElement("button");
  connectButton.id = `${PANEL_ID}-connect-button`;
  connectButton.textContent = "Connect Twitch";
  connectButton.style.cssText = "margin-right:6px;cursor:pointer;";
  connectButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "start-link" }).then(updateAccountSection);
  });
  panel.appendChild(connectButton);

  const disconnectButton = document.createElement("button");
  disconnectButton.id = `${PANEL_ID}-disconnect-button`;
  disconnectButton.textContent = "Disconnect";
  disconnectButton.style.cssText = "cursor:pointer;display:none;";
  disconnectButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "disconnect-link" }).then(updateAccountSection);
  });
  panel.appendChild(disconnectButton);

  updateAccountSection();
}

// Polls the background worker's link state rather than relying on a push —
// same reasoning as updatePublishStatus below: robust to the MV3 service
// worker being suspended and woken back up between polls. Never renders the
// stored credential itself, only the human-facing status derived from it.
function updateAccountSection(): void {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const statusEl = panel.querySelector<HTMLDivElement>(`#${PANEL_ID}-account-status`);
  const connectButton = panel.querySelector<HTMLButtonElement>(`#${PANEL_ID}-connect-button`);
  const disconnectButton = panel.querySelector<HTMLButtonElement>(`#${PANEL_ID}-disconnect-button`);
  if (!statusEl || !connectButton || !disconnectButton) return;

  chrome.runtime
    .sendMessage({ type: "get-link-state" })
    .then((state: LinkState | undefined) => {
      const status: LinkState["status"] = state?.status ?? "not-connected";
      const label = LINK_STATUS_LABEL[status];
      statusEl.textContent = status === "connected" && state?.displayName ? `${label} as ${state.displayName}` : label;

      const showConnect = status === "not-connected" || status === "credential-expired" || status === "backend-unavailable";
      connectButton.style.display = showConnect ? "inline-block" : "none";
      disconnectButton.style.display = status === "connected" ? "inline-block" : "none";
    })
    .catch(() => {
      statusEl.textContent = LINK_STATUS_LABEL["backend-unavailable"];
      connectButton.style.display = "inline-block";
      disconnectButton.style.display = "none";
    });
}

setInterval(updateAccountSection, 2000);

function ensurePanel(): HTMLElement {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = [
    "position:fixed",
    "bottom:12px",
    "right:12px",
    "z-index:2147483647",
    "background:#111",
    "color:#eee",
    "font:12px/1.4 monospace",
    "padding:10px",
    "border:1px solid #444",
    "border-radius:6px",
    "width:280px",
    "max-height:60vh",
    "overflow:auto",
    "box-shadow:0 4px 16px rgba(0,0,0,0.5)",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "RiftSight Inspector (debug)";
  title.style.cssText = "font-weight:bold;margin-bottom:6px;";
  panel.appendChild(title);

  buildAccountSection(panel);

  const investigationDivider = document.createElement("hr");
  investigationDivider.style.cssText = "margin:8px 0;border-color:#333;";
  panel.appendChild(investigationDivider);

  const status = document.createElement("div");
  status.id = `${PANEL_ID}-status`;
  status.textContent = "No scan yet. Press Alt+Shift+R or click Scan now.";
  status.style.cssText = "margin-bottom:6px;white-space:pre-wrap;";
  panel.appendChild(status);

  const scanButton = document.createElement("button");
  scanButton.textContent = "Scan now";
  scanButton.style.cssText = "margin-right:6px;cursor:pointer;";
  scanButton.addEventListener("click", runScan);
  panel.appendChild(scanButton);

  const copyButton = document.createElement("button");
  copyButton.textContent = "Copy JSON";
  copyButton.style.cssText = "cursor:pointer;";
  copyButton.addEventListener("click", () => {
    if (!lastResult) return;
    void navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
    copyButton.textContent = "Copied!";
    setTimeout(() => {
      copyButton.textContent = "Copy JSON";
    }, 1200);
  });
  panel.appendChild(copyButton);

  const divider = document.createElement("hr");
  divider.style.cssText = "margin:8px 0;border-color:#333;";
  panel.appendChild(divider);

  const detectStatus = document.createElement("div");
  detectStatus.id = `${PANEL_ID}-detect-status`;
  detectStatus.textContent = "Real detector: press Alt+Shift+D or click Detect cards.";
  detectStatus.style.cssText = "margin-bottom:6px;white-space:pre-wrap;";
  panel.appendChild(detectStatus);

  const detectButton = document.createElement("button");
  detectButton.textContent = "Detect cards";
  detectButton.style.cssText = "margin-right:6px;cursor:pointer;";
  detectButton.addEventListener("click", runDetect);
  panel.appendChild(detectButton);

  const detectDelayedButton = document.createElement("button");
  detectDelayedButton.textContent = `Detect in ${DELAYED_DETECT_SECONDS}s (hover target first)`;
  detectDelayedButton.style.cssText = "cursor:pointer;";
  detectDelayedButton.addEventListener("click", runDetectDelayed);
  panel.appendChild(detectDelayedButton);

  const publishDivider = document.createElement("hr");
  publishDivider.style.cssText = "margin:8px 0;border-color:#333;";
  panel.appendChild(publishDivider);

  const publishTitle = document.createElement("div");
  publishTitle.textContent = "Live Publishing";
  publishTitle.style.cssText = "font-weight:bold;margin-bottom:4px;";
  panel.appendChild(publishTitle);

  // In closed-beta mode the Account section above is the sole "which
  // channel does this publish to" mechanism (the linked Twitch identity
  // resolves it server-side) — the manual field stays available only in
  // development/twitch-local-test, per the milestone spec.
  let sessionInput: HTMLInputElement | undefined;
  if (!isClosedBeta) {
    const sessionLabel = document.createElement("div");
    sessionLabel.textContent = "Session ID (or Twitch test channel ID — Local Test only, see README)";
    sessionLabel.style.cssText = "font-size:11px;color:#999;margin-bottom:2px;";
    panel.appendChild(sessionLabel);

    // This one field is the entire "which channel/session does this
    // publisher route to" mechanism — the relay and every viewer (debug
    // viewer, Twitch overlay) just key off whatever string ends up here.
    // For a real Twitch Local Test run, that means typing your numeric
    // Twitch channel ID in directly; there's no separate Twitch-specific
    // setting because none is needed. See README's Local Test section.
    sessionInput = document.createElement("input");
    sessionInput.id = `${PANEL_ID}-session-input`;
    sessionInput.type = "text";
    sessionInput.value = DEFAULT_SESSION_ID;
    sessionInput.placeholder = "local-debug, or a Twitch channel id for Local Test";
    sessionInput.spellcheck = false;
    sessionInput.style.cssText =
      "width:100%;margin-bottom:4px;box-sizing:border-box;background:#000;color:#eee;border:1px solid #444;padding:2px 4px;";
    panel.appendChild(sessionInput);
  }

  const publishStatus = document.createElement("div");
  publishStatus.id = `${PANEL_ID}-publish-status`;
  publishStatus.textContent = "Not publishing.";
  publishStatus.style.cssText = "margin-bottom:6px;white-space:pre-wrap;";
  panel.appendChild(publishStatus);

  const publishToggle = document.createElement("button");
  publishToggle.id = `${PANEL_ID}-publish-toggle`;
  publishToggle.textContent = "Start publishing";
  publishToggle.style.cssText = "cursor:pointer;";
  publishToggle.addEventListener("click", () => {
    if (isPublishing()) {
      stopPublishing();
    } else {
      const sessionId = isClosedBeta ? CLOSED_BETA_SESSION_PLACEHOLDER : sessionInput?.value.trim() || DEFAULT_SESSION_ID;
      startPublishing(sessionId);
    }
    publishToggle.textContent = isPublishing() ? "Stop publishing" : "Start publishing";
    if (sessionInput) sessionInput.disabled = isPublishing();
    updatePublishStatus();
  });
  panel.appendChild(publishToggle);

  document.body.appendChild(panel);
  return panel;
}

function updatePublishStatus(): void {
  const panel = ensurePanel();
  const statusEl = panel.querySelector<HTMLDivElement>(`#${PANEL_ID}-publish-status`);
  if (!statusEl) return;

  if (!isPublishing()) {
    statusEl.textContent = "Not publishing.";
    return;
  }

  chrome.runtime
    .sendMessage({ type: "get-status" })
    .then((response: { status?: string; hasUnsent?: boolean; replaced?: boolean } | undefined) => {
      // "disconnected" always implies background.ts's scheduleReconnect is
      // already retrying (see connect()'s close handler) — the friendly
      // wording says so rather than the bare technical status string.
      // "replaced" is the one disconnect reason distinguishable from a
      // generic one (a visible WS close code on an already-open socket —
      // see background.ts's PRODUCER_REPLACED_CLOSE_CODE), so it gets its
      // own, more specific message.
      const relayLine = response?.replaced
        ? describeStreamerError("producer-replaced")
        : response?.status === "disconnected"
          ? describeStreamerError("relay-reconnecting")
          : `Relay: ${response?.status ?? "unknown"}`;
      statusEl.textContent = ["Publishing.", relayLine, `Snapshots sent: ${publishedSnapshotCount()}`].join("\n");
    })
    .catch(() => {
      statusEl.textContent = `Publishing.\n${describeStreamerError("backend-unreachable")}\nSnapshots sent: ${publishedSnapshotCount()}`;
    });
}

// Polls the background worker's connection status rather than relying on a
// push — simpler, and robust to the background service worker being
// suspended and woken back up between polls.
setInterval(updatePublishStatus, 2000);

function updatePanel(result: ScanResult, counts: Record<Signal, number>): void {
  const panel = ensurePanel();
  const status = panel.querySelector<HTMLDivElement>(`#${PANEL_ID}-status`);
  if (!status) return;
  status.textContent = [
    `${result.entries.length} candidate(s)`,
    `img-alt: ${counts["img-alt"]}`,
    `bg-image: ${counts["bg-image"]}`,
    `aria-label: ${counts["aria-label"]}`,
    `data-card-attr: ${counts["data-card-attr"]}`,
    `canvas elements: ${result.canvases.length}`,
    "",
    "Full JSON logged to console.",
  ].join("\n");
}

// Exposed as an ad-hoc debug command so it can be run from the DevTools
// console too, not just the panel button — no formal Window typing needed
// since this script is never imported as a module.
(window as unknown as { __riftsightScan: () => void }).__riftsightScan = runScan;

// Alt+Shift+R triggers a heuristic scan, Alt+Shift+D the real detector,
// Alt+Shift+H a delayed detector run — none require hunting for the panel
// first.
window.addEventListener("keydown", (event) => {
  if (!event.altKey || !event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key === "r") runScan();
  if (key === "d") runDetect();
  if (key === "h") runDetectDelayed();
});

ensurePanel();
