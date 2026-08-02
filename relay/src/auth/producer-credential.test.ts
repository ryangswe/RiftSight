import { describe, expect, it } from "vitest";
import { generateProducerCredential, hashProducerCredential } from "./producer-credential.js";

describe("generateProducerCredential", () => {
  it("generates a non-empty, url-safe token", () => {
    const token = generateProducerCredential();
    expect(token.length).toBeGreaterThan(20);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a distinct token on every call", () => {
    const a = generateProducerCredential();
    const b = generateProducerCredential();
    expect(a).not.toBe(b);
  });
});

describe("hashProducerCredential", () => {
  it("is deterministic for the same input", () => {
    const token = generateProducerCredential();
    expect(hashProducerCredential(token)).toBe(hashProducerCredential(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashProducerCredential("token-a")).not.toBe(hashProducerCredential("token-b"));
  });

  it("never returns the raw token itself", () => {
    const token = "a-recognizable-raw-token-value";
    expect(hashProducerCredential(token)).not.toBe(token);
    expect(hashProducerCredential(token)).not.toContain(token);
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    const hash = hashProducerCredential("anything");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
