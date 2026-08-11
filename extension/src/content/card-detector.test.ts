// @vitest-environment happy-dom
//
// Only resolveFaceFacing's own tests below actually need a DOM (real
// parent/child structure via parentElement, document order via
// compareDocumentPosition, computed backfaceVisibility/transform) — every
// other test in this file operates on plain values and would pass under
// the default Node environment too. happy-dom is applied file-wide rather
// than per-describe-block since vitest's environment pragma is a whole-file
// directive, and it costs those other tests nothing to run under it.

import { describe, expect, it } from "vitest";
import {
  isDetectableInstanceId,
  mergePreferPublic,
  resolveFaceFacing,
  toDropZone,
  upgradeToOriginalResolution,
} from "./card-detector.js";
import type { CardDetection } from "./types.js";

describe("isDetectableInstanceId", () => {
  it("accepts the short-hex id format seen in an earlier capture", () => {
    expect(isDetectableInstanceId("card_18076bb4")).toBe(true);
  });

  it("accepts a full-UUID id format — the shape that silently went undetected in a real incident", () => {
    expect(isDetectableInstanceId("card_80552594-720d-493b-b569-8ed4162a75b4")).toBe(true);
  });

  it("accepts both battlefield slot markers", () => {
    expect(isDetectableInstanceId("battlefield-marker:battlefieldA")).toBe(true);
    expect(isDetectableInstanceId("battlefield-marker:battlefieldB")).toBe(true);
  });

  it("rejects the base-area marker — a lane-wide drop target, not a specific card", () => {
    expect(isDetectableInstanceId("base-area-marker:plr_e77e452b")).toBe(false);
  });

  it("rejects an empty or garbage id", () => {
    expect(isDetectableInstanceId("")).toBe(false);
    expect(isDetectableInstanceId("not-a-card-id")).toBe(false);
  });

  it("is case-insensitive on hex digits, matching how the ids have actually appeared", () => {
    expect(isDetectableInstanceId("card_ABCDEF12")).toBe(true);
    expect(isDetectableInstanceId("card_80552594-720D-493B-B569-8ED4162A75B4")).toBe(true);
  });

  it("accepts the live-captured chain-zone composite id", () => {
    expect(
      isDetectableInstanceId(
        "chain-plr_7a07bb13-card_7db9227a-a606-430b-98b5-ec280c610b34-d526be66-1952-41c9-9a91-2887d66d7f36"
      )
    ).toBe(true);
  });

  it("accepts the later-observed plain 'chain_<uuid>' shape (underscore, no embedded plr_/card_ segments) — RiftAtlas changed this format after the hyphenated example above was captured, silently going undetected until the pattern was widened", () => {
    expect(isDetectableInstanceId("chain_516ff5cf-5ff9-4245-b037-86bcda220c85")).toBe(true);
  });
});

describe("toDropZone", () => {
  it("uses the data-drop-zone attribute when it's a known zone", () => {
    expect(toDropZone("hand", "card_abc123")).toBe("hand");
  });

  it("falls back to 'unknown' for an unrecognized data-drop-zone value", () => {
    expect(toDropZone("some-new-zone-riftatlas-adds-later", "card_abc123")).toBe("unknown");
  });

  it("classifies as 'chain' from the instance id alone when data-drop-zone is null — the live-captured case, since the chain card carries no data-drop-zone attribute at all", () => {
    expect(
      toDropZone(null, "chain-plr_7a07bb13-card_7db9227a-a606-430b-98b5-ec280c610b34-d526be66-1952-41c9-9a91-2887d66d7f36")
    ).toBe("chain");
  });

  it("also classifies the later-observed underscore 'chain_<uuid>' shape as 'chain'", () => {
    expect(toDropZone(null, "chain_516ff5cf-5ff9-4245-b037-86bcda220c85")).toBe("chain");
  });

  it("falls back to 'unknown' when neither the attribute nor the instance id gives a signal", () => {
    expect(toDropZone(null, "card_abc123")).toBe("unknown");
  });
});

describe("upgradeToOriginalResolution", () => {
  it("reproduces the live-captured hand-card case: bumps width to 640 through the resize proxy and swaps to the original tier", () => {
    // Real captured URL. width=256 combined with the original tier was
    // live-probed and confirmed to fail to load entirely — this is exactly
    // why the fix bumps the width rather than leaving it as-is.
    expect(
      upgradeToOriginalResolution(
        "https://assets.riftatlas-workers.com/cdn-cgi/image/width=256,quality=85,format=auto,fit=scale-down/riftbound/cards/small-v2/OGN-058.webp?v=90f84ac6b48e8414"
      )
    ).toBe(
      "https://assets.riftatlas-workers.com/cdn-cgi/image/width=640,quality=85,format=auto,fit=scale-down/riftbound/cards/original/OGN-058.webp?v=90f84ac6b48e8414"
    );
  });

  it("bumps a wider-but-still-capped width (384, seen on other board contexts) to 640 too", () => {
    expect(
      upgradeToOriginalResolution(
        "https://assets.riftatlas-workers.com/cdn-cgi/image/width=384,quality=85,format=auto,fit=scale-down/riftbound/cards/small-v2/SFD-195.webp?v=1"
      )
    ).toBe(
      "https://assets.riftatlas-workers.com/cdn-cgi/image/width=640,quality=85,format=auto,fit=scale-down/riftbound/cards/original/SFD-195.webp?v=1"
    );
  });

  it("leaves an already-original, already-width=640 URL unchanged — the live-captured chain-card case", () => {
    const url =
      "https://assets.riftatlas-workers.com/cdn-cgi/image/width=640,quality=85,format=auto,fit=scale-down/riftbound/cards/original/UNL-128.webp?v=a8a7ed67930968c4";
    expect(upgradeToOriginalResolution(url)).toBe(url);
  });

  it("swaps the tier on a bare URL with no resize proxy segment at all, falling back to uncapped native resolution rather than guessing how to construct one", () => {
    expect(upgradeToOriginalResolution("https://assets.riftatlas-workers.com/riftbound/cards/small-v2/OGN-058.webp")).toBe(
      "https://assets.riftatlas-workers.com/riftbound/cards/original/OGN-058.webp"
    );
  });

  it("leaves an already-bare original URL unchanged", () => {
    const url = "https://assets.riftatlas-workers.com/riftbound/cards/original/OGN-058.webp";
    expect(upgradeToOriginalResolution(url)).toBe(url);
  });

  it("leaves a URL with no recognized tier segment unchanged, rather than guessing", () => {
    const url = "https://cdn.example.com/cardback-white.png";
    expect(upgradeToOriginalResolution(url)).toBe(url);
  });
});

describe("mergePreferPublic", () => {
  function detection(overrides: Partial<CardDetection> = {}): CardDetection {
    return {
      instanceId: "card_1",
      cardId: undefined,
      name: undefined,
      imageUrl: undefined,
      visibility: "unknown",
      dropZone: "hand",
      owner: "self",
      rotationDeg: 0,
      landscape: false,
      zIndexHint: undefined,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      localWidth: 100,
      localHeight: 100,
      fromDialog: false,
      element: document.createElement("div"),
      ...overrides,
    };
  }

  it("inserts the detection when nothing is registered for that id yet", () => {
    const map = new Map<string, CardDetection>();
    const first = detection({ visibility: "hidden" });
    mergePreferPublic(map, "card_1", first);
    expect(map.get("card_1")).toBe(first);
  });

  it("replaces a non-public existing entry with a public duplicate — the upgrade case", () => {
    const map = new Map<string, CardDetection>();
    mergePreferPublic(map, "card_1", detection({ visibility: "hidden" }));
    const upgraded = detection({ visibility: "public", cardId: "OGN-089" });
    mergePreferPublic(map, "card_1", upgraded);
    expect(map.get("card_1")).toBe(upgraded);
  });

  it("keeps an existing public entry rather than overwriting it with a non-public duplicate — never downgrades", () => {
    const map = new Map<string, CardDetection>();
    const original = detection({ visibility: "public", cardId: "OGN-089" });
    mergePreferPublic(map, "card_1", original);
    mergePreferPublic(map, "card_1", detection({ visibility: "hidden" }));
    expect(map.get("card_1")).toBe(original);
  });

  it("keeps the first public entry when a second public duplicate arrives for the same id", () => {
    const map = new Map<string, CardDetection>();
    const first = detection({ visibility: "public", cardId: "OGN-089" });
    mergePreferPublic(map, "card_1", first);
    mergePreferPublic(map, "card_1", detection({ visibility: "public", cardId: "OGN-999" }));
    expect(map.get("card_1")).toBe(first);
  });

  it("keeps the first non-public entry when a second non-public duplicate arrives for the same id", () => {
    const map = new Map<string, CardDetection>();
    const first = detection({ visibility: "hidden" });
    mergePreferPublic(map, "card_1", first);
    mergePreferPublic(map, "card_1", detection({ visibility: "unknown" }));
    expect(map.get("card_1")).toBe(first);
  });
});

describe("resolveFaceFacing", () => {
  // Real captured matrix values from face-transform.ts's own header comment
  // — "none" (identity, 0deg) and the confirmed rotateY(180deg) matrix3d —
  // rather than inventing new ones, so a disagreement here would also flag
  // if the two modules' shared assumptions about these values drift apart.
  const FRONT_TRANSFORM = "none";
  const BACK_TRANSFORM = "matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1)";

  // happy-dom's getComputedStyle only reflects inline styles for elements
  // actually connected to the document (confirmed directly: an identical
  // detached tree returns "" for every computed property, even a plain
  // `color: red` sanity check) — appending to document.body is therefore
  // required, not optional, for any test exercising findBackfaceHiddenAncestor.
  function faceWithWrapper(parent: HTMLElement): HTMLImageElement {
    const wrapper = document.createElement("div");
    wrapper.style.backfaceVisibility = "hidden";
    const img = document.createElement("img");
    wrapper.appendChild(img);
    parent.appendChild(wrapper);
    return img;
  }

  it("classifies via the shared flip parent's transform when both faces have a backface-hidden wrapper under one shared parent", () => {
    const front = document.createElement("div");
    front.style.transform = FRONT_TRANSFORM;
    document.body.appendChild(front);
    const frontFace = faceWithWrapper(front);
    const backFace = faceWithWrapper(front);
    expect(resolveFaceFacing(frontFace, backFace)).toBe("front");
  });

  it("classifies as 'back' when the shared parent's transform is the confirmed rotateY(180deg) matrix", () => {
    const parent = document.createElement("div");
    parent.style.transform = BACK_TRANSFORM;
    document.body.appendChild(parent);
    const frontFace = faceWithWrapper(parent);
    const backFace = faceWithWrapper(parent);
    expect(resolveFaceFacing(frontFace, backFace)).toBe("back");
  });

  it("falls back to document order when neither face has a backface-hidden wrapper at all — the Deck Peek case", () => {
    const container = document.createElement("div");
    const frontFace = document.createElement("img");
    const backFace = document.createElement("img");
    container.appendChild(frontFace);
    container.appendChild(backFace);
    // backFace is the later sibling, so standard same-z-index stacking says it paints on top.
    expect(resolveFaceFacing(frontFace, backFace)).toBe("back");
  });

  it("resolves to whichever face is later in document order, regardless of which argument is 'front'", () => {
    const container = document.createElement("div");
    const backFace = document.createElement("img");
    const frontFace = document.createElement("img");
    container.appendChild(backFace);
    container.appendChild(frontFace);
    // frontFace is now the later sibling.
    expect(resolveFaceFacing(frontFace, backFace)).toBe("front");
  });

  it("returns 'unsupported' when only one side has a backface-hidden wrapper — an unexpected, ambiguous structure", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const frontFace = faceWithWrapper(parent);
    const backFace = document.createElement("img");
    parent.appendChild(backFace);
    expect(resolveFaceFacing(frontFace, backFace)).toBe("unsupported");
  });

  it("returns 'unsupported' when both faces have wrappers but the wrappers don't share a parent", () => {
    const parentA = document.createElement("div");
    const parentB = document.createElement("div");
    document.body.appendChild(parentA);
    document.body.appendChild(parentB);
    const frontFace = faceWithWrapper(parentA);
    const backFace = faceWithWrapper(parentB);
    expect(resolveFaceFacing(frontFace, backFace)).toBe("unsupported");
  });
});
