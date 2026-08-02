import { describe, expect, it } from "vitest";
import { createLinkHandoffStore } from "./link-handoff.js";

const readyResult = { credential: "raw-credential-value", displayName: "juicykaraage" };

describe("createLinkHandoffStore", () => {
  it("an unknown linkId reports not-found", () => {
    const store = createLinkHandoffStore();
    expect(store.status("never-seen")).toBe("not-found");
  });

  it("markPending, then status is pending", () => {
    const store = createLinkHandoffStore();
    store.markPending("link-1");
    expect(store.status("link-1")).toBe("pending");
  });

  it("markReady, then status is ready", () => {
    const store = createLinkHandoffStore();
    store.markPending("link-1");
    store.markReady("link-1", readyResult);
    expect(store.status("link-1")).toBe("ready");
  });

  it("markReady without a prior markPending still works", () => {
    const store = createLinkHandoffStore();
    store.markReady("link-1", readyResult);
    expect(store.status("link-1")).toBe("ready");
  });

  it("redeem returns the credential and display name once ready", () => {
    const store = createLinkHandoffStore();
    store.markReady("link-1", readyResult);
    expect(store.redeem("link-1")).toEqual(readyResult);
  });

  it("redeem is single-use — a second call returns undefined", () => {
    const store = createLinkHandoffStore();
    store.markReady("link-1", readyResult);
    store.redeem("link-1");
    expect(store.redeem("link-1")).toBeUndefined();
  });

  it("redeem returns undefined and does not error while still pending", () => {
    const store = createLinkHandoffStore();
    store.markPending("link-1");
    expect(store.redeem("link-1")).toBeUndefined();
    expect(store.status("link-1")).toBe("pending"); // not consumed by the failed redeem attempt
  });

  it("status is not-found for an entry after its TTL elapses", () => {
    let currentTime = 1000;
    const store = createLinkHandoffStore({ ttlMs: 5000, now: () => currentTime });
    store.markReady("link-1", readyResult);
    currentTime += 5001;
    expect(store.status("link-1")).toBe("not-found");
  });

  it("redeem fails for an expired entry even though it was ready", () => {
    let currentTime = 1000;
    const store = createLinkHandoffStore({ ttlMs: 5000, now: () => currentTime });
    store.markReady("link-1", readyResult);
    currentTime += 5001;
    expect(store.redeem("link-1")).toBeUndefined();
  });

  it("tracks multiple independent linkIds without interference", () => {
    const store = createLinkHandoffStore();
    store.markPending("link-a");
    store.markReady("link-b", { credential: "cred-b", displayName: "streamer_b" });
    expect(store.status("link-a")).toBe("pending");
    expect(store.status("link-b")).toBe("ready");
    expect(store.redeem("link-b")).toEqual({ credential: "cred-b", displayName: "streamer_b" });
    expect(store.status("link-a")).toBe("pending");
  });
});
