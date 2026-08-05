import { describe, expect, it } from "vitest";
import { RELAY_URL } from "@riftsight/protocol";
import { resolveRelayUrl } from "./relay-url.js";

describe("resolveRelayUrl", () => {
  describe("mock mode", () => {
    it("defaults to localhost RELAY_URL when nothing is configured", () => {
      expect(resolveRelayUrl({ isMock: true, configuredUrl: "", isSecureContext: false })).toBe(RELAY_URL);
    });

    it("uses an explicitly configured URL if one is given, even in mock mode", () => {
      const url = resolveRelayUrl({ isMock: true, configuredUrl: "wss://example.trycloudflare.com", isSecureContext: false });
      expect(url).toBe("wss://example.trycloudflare.com");
    });
  });

  describe("real Twitch mode", () => {
    it("throws a clear diagnostic when no relay URL is configured", () => {
      expect(() => resolveRelayUrl({ isMock: false, configuredUrl: "", isSecureContext: true })).toThrow(
        /RIFTSIGHT_RELAY_URL is not configured/
      );
    });

    it("rejects a ws: URL in a secure context (mixed content) with a clear diagnostic", () => {
      expect(() => resolveRelayUrl({ isMock: false, configuredUrl: "ws://example.com:8787", isSecureContext: true })).toThrow(
        /must use wss:/
      );
    });

    it("accepts a valid wss: URL in a secure context", () => {
      const url = resolveRelayUrl({ isMock: false, configuredUrl: "wss://example.trycloudflare.com", isSecureContext: true });
      expect(url).toBe("wss://example.trycloudflare.com");
    });

    it("does not reject ws: when not in a secure context (e.g. a non-HTTPS dev scenario)", () => {
      const url = resolveRelayUrl({ isMock: false, configuredUrl: "ws://example.com:8787", isSecureContext: false });
      expect(url).toBe("ws://example.com:8787");
    });
  });
});
