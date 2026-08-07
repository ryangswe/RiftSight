import { describe, expect, it } from "vitest";
import { isDetectableInstanceId, isExtremeZIndex, toDropZone, upgradeToOriginalResolution } from "./card-detector.js";

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

describe("isExtremeZIndex", () => {
  it("reproduces the live-captured portal-wrapper value shared by Trash/Banished and Deck Peek", () => {
    expect(isExtremeZIndex("2147483646")).toBe(true);
  });

  it("rejects real board z-index values seen live (small integers)", () => {
    expect(isExtremeZIndex("1")).toBe(false);
    expect(isExtremeZIndex("2")).toBe(false);
    expect(isExtremeZIndex("3")).toBe(false);
  });

  it("rejects 'auto', the default for every board element without an explicit z-index", () => {
    expect(isExtremeZIndex("auto")).toBe(false);
  });
});
