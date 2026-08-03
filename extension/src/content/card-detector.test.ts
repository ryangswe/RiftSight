import { describe, expect, it } from "vitest";
import { isDetectableInstanceId } from "./card-detector.js";

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
});
