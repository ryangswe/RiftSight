import { describe, expect, it } from "vitest";
import { resolveProducerWsUrl, resolveViewerWsUrl } from "./producer-url.js";

describe("resolveProducerWsUrl", () => {
  it("returns the fallback relay URL when there's no stored credential", () => {
    const url = resolveProducerWsUrl({ backendUrl: "http://localhost:8788", credential: undefined, fallbackRelayUrl: "ws://localhost:8787" });
    expect(url).toBe("ws://localhost:8787");
  });

  it("derives a ws:// authenticated producer URL from an http:// backend origin", () => {
    const url = resolveProducerWsUrl({ backendUrl: "http://localhost:8788", credential: "tok123", fallbackRelayUrl: "ws://localhost:8787" });
    expect(url).toBe("ws://localhost:8788/ws/producer?credential=tok123");
  });

  it("derives a wss:// authenticated producer URL from an https:// backend origin", () => {
    const url = resolveProducerWsUrl({ backendUrl: "https://beta.example.com", credential: "tok123", fallbackRelayUrl: "ws://localhost:8787" });
    expect(url).toBe("wss://beta.example.com/ws/producer?credential=tok123");
  });

  it("url-encodes a credential containing special characters", () => {
    const url = resolveProducerWsUrl({ backendUrl: "http://localhost:8788", credential: "a+b/c=", fallbackRelayUrl: "ws://localhost:8787" });
    expect(url).toBe("ws://localhost:8788/ws/producer?credential=a%2Bb%2Fc%3D");
  });

  it("throws a clear error when a credential exists but the backend URL is unconfigured", () => {
    expect(() => resolveProducerWsUrl({ backendUrl: "", credential: "tok123", fallbackRelayUrl: "ws://localhost:8787" })).toThrow(
      /RIFTSIGHT_BACKEND_URL is not configured/
    );
  });

  it("throws a clear error when the backend URL is malformed", () => {
    expect(() => resolveProducerWsUrl({ backendUrl: "not a url", credential: "tok123", fallbackRelayUrl: "ws://localhost:8787" })).toThrow(
      /not a valid URL/
    );
  });
});

describe("resolveViewerWsUrl", () => {
  it("falls back to the local relay when no backend is configured (development)", () => {
    expect(resolveViewerWsUrl({ backendUrl: "", fallbackRelayUrl: "ws://localhost:8787" })).toBe("ws://localhost:8787");
  });

  it("derives wss on the plain '/' path from an https backend origin — no credential, not /ws/producer", () => {
    const url = resolveViewerWsUrl({ backendUrl: "https://beta.riftsight.example.com", fallbackRelayUrl: "ws://localhost:8787" });
    expect(url).toBe("wss://beta.riftsight.example.com/");
    expect(url).not.toContain("credential");
    expect(url).not.toContain("/ws/producer");
  });

  it("throws on a malformed backend URL", () => {
    expect(() => resolveViewerWsUrl({ backendUrl: "not a url", fallbackRelayUrl: "ws://x" })).toThrow();
  });
});
