import { describe, expect, it } from "vitest";
import { nextPublishingAction, type PublishingLifecycleInput } from "./publishing-lifecycle.js";

function input(overrides: Partial<PublishingLifecycleInput> = {}): PublishingLifecycleInput {
  return { intent: false, boardDetected: false, isPublishing: false, ...overrides };
}

describe("nextPublishingAction", () => {
  it("starts when intent is on, a board is present, and nothing is running yet — covers reload/close-reopen resume", () => {
    expect(nextPublishingAction(input({ intent: true, boardDetected: true, isPublishing: false }))).toBe("start");
  });

  it("does nothing when intent is on but no board is present yet — the idle-waiting state", () => {
    expect(nextPublishingAction(input({ intent: true, boardDetected: false, isPublishing: false }))).toBe("none");
  });

  it("does nothing when already publishing and the board is still there — steady state", () => {
    expect(nextPublishingAction(input({ intent: true, boardDetected: true, isPublishing: true }))).toBe("none");
  });

  it("stops when actively publishing and the board disappears, regardless of intent", () => {
    expect(nextPublishingAction(input({ intent: true, boardDetected: false, isPublishing: true }))).toBe("stop");
    expect(nextPublishingAction(input({ intent: false, boardDetected: false, isPublishing: true }))).toBe("stop");
  });

  it("never starts when intent is off, no matter how many times a board appears — explicit Stop must not auto-resume", () => {
    expect(nextPublishingAction(input({ intent: false, boardDetected: true, isPublishing: false }))).toBe("none");
  });

  it("does nothing when nothing is happening at all", () => {
    expect(nextPublishingAction(input())).toBe("none");
  });

  it("does nothing when publishing has already stopped and intent is off", () => {
    expect(nextPublishingAction(input({ intent: false, boardDetected: false, isPublishing: false }))).toBe("none");
  });
});
