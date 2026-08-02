import { describe, expect, it } from "vitest";
import { resolveProducerWsUrl } from "./producer-url.js";

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

  it("ignores a backend URL path/query if one is present, keeping only its origin", () => {
    const url = resolveProducerWsUrl({ backendUrl: "https://beta.example.com/some/path?x=1", credential: "tok123", fallbackRelayUrl: "ws://localhost:8787" });
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
