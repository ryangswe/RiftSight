import { describe, expect, it } from "vitest";
import { createStateStore } from "./state-store.js";

describe("createStateStore", () => {
  it("consumes a just-issued state successfully", () => {
    const store = createStateStore();
    const state = store.issue();
    expect(store.consume(state)).toEqual({ valid: true, linkId: undefined });
  });

  it("rejects a state value that was never issued", () => {
    const store = createStateStore();
    expect(store.consume("never-issued")).toEqual({ valid: false, linkId: undefined });
  });

  it("is single-use — consuming the same state twice fails the second time", () => {
    const store = createStateStore();
    const state = store.issue();
    expect(store.consume(state).valid).toBe(true);
    expect(store.consume(state).valid).toBe(false);
  });

  it("issues a fresh, distinct value on every call", () => {
    const store = createStateStore();
    const a = store.issue();
    const b = store.issue();
    expect(a).not.toBe(b);
  });

  it("rejects a state consumed after its TTL has elapsed", () => {
    let currentTime = 1000;
    const store = createStateStore({ ttlMs: 5000, now: () => currentTime });
    const state = store.issue();
    currentTime += 5001;
    expect(store.consume(state).valid).toBe(false);
  });

  it("accepts a state consumed exactly at the TTL boundary", () => {
    let currentTime = 1000;
    const store = createStateStore({ ttlMs: 5000, now: () => currentTime });
    const state = store.issue();
    currentTime += 5000;
    expect(store.consume(state).valid).toBe(true);
  });

  it("supports an injected random-state generator for deterministic tests", () => {
    let counter = 0;
    const store = createStateStore({ randomState: () => `state-${counter++}` });
    expect(store.issue()).toBe("state-0");
    expect(store.issue()).toBe("state-1");
  });

  it("hands back the associated linkId on a valid consume", () => {
    const store = createStateStore();
    const state = store.issue("link-abc");
    expect(store.consume(state)).toEqual({ valid: true, linkId: "link-abc" });
  });

  it("does not hand back a linkId for an invalid/expired consume", () => {
    let currentTime = 1000;
    const store = createStateStore({ ttlMs: 5000, now: () => currentTime });
    const state = store.issue("link-abc");
    currentTime += 5001;
    expect(store.consume(state)).toEqual({ valid: false, linkId: undefined });
  });
});
