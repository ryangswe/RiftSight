import { describe, expect, it } from "vitest";
import { createRateLimiter, isSlowConsumer, messageByteLength, MAX_OUTBOUND_QUEUE_BYTES } from "./rate-limit.js";

describe("createRateLimiter", () => {
  it("allows events up to maxEvents within a window, then rejects", () => {
    const limiter = createRateLimiter({ maxEvents: 3, windowMs: 1000 });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const limiter = createRateLimiter({ maxEvents: 1, windowMs: 1000 });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(false);
  });

  it("resets once the window elapses", () => {
    let now = 0;
    const limiter = createRateLimiter({ maxEvents: 1, windowMs: 1000, now: () => now });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    now = 1000;
    expect(limiter.tryConsume("a")).toBe(true);
  });
});

describe("messageByteLength", () => {
  it("counts ASCII characters 1:1", () => {
    expect(messageByteLength("hello")).toBe(5);
  });

  it("counts multi-byte UTF-8 characters correctly, not by JS string length", () => {
    const emoji = "🔥"; // 2 UTF-16 code units, 4 UTF-8 bytes
    expect(emoji.length).toBe(2);
    expect(messageByteLength(emoji)).toBe(4);
  });
});

describe("isSlowConsumer", () => {
  it("is false at and below the threshold", () => {
    expect(isSlowConsumer(0)).toBe(false);
    expect(isSlowConsumer(MAX_OUTBOUND_QUEUE_BYTES)).toBe(false);
  });

  it("is true above the threshold", () => {
    expect(isSlowConsumer(MAX_OUTBOUND_QUEUE_BYTES + 1)).toBe(true);
  });
});
