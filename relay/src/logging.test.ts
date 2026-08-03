import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "./logging.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("logEvent", () => {
  it("emits one JSON line with the event name, a timestamp, and allowed fields", () => {
    logEvent("producer_connected", { channelId: "141981764", broadcasterId: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("producer_connected");
    expect(parsed.channelId).toBe("141981764");
    expect(parsed.broadcasterId).toBe(1);
    expect(typeof parsed.ts).toBe("string");
  });

  it("drops a field not on the allowlist and never includes it in the emitted JSON", () => {
    logEvent("producer_authenticated", { channelId: "141981764", credential: "super-secret-token" } as never);
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("super-secret-token");
    expect(JSON.parse(line)).not.toHaveProperty("credential");
  });

  it("warns once per unrecognized field name, not on every call", () => {
    logEvent("event_a", { notAllowed: "x" } as never);
    logEvent("event_b", { notAllowed: "y" } as never);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("omits undefined-valued fields without warning", () => {
    logEvent("viewer_admitted", { channelId: "141981764", reason: undefined });
    expect(warnSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).not.toHaveProperty("reason");
  });

  it("allows every startup_summary field through with no warning", () => {
    logEvent("startup_summary", {
      mode: "closed-beta",
      databaseConfigured: true,
      databasePersistentPath: true,
      localDebugEnabled: false,
      producerAuthRequired: true,
      twitchViewerAuthConfigured: true,
      oauthConfigured: true,
      publicBackendOrigin: "beta.example.com",
    });
    expect(warnSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({
      mode: "closed-beta",
      databaseConfigured: true,
      databasePersistentPath: true,
      localDebugEnabled: false,
      producerAuthRequired: true,
      twitchViewerAuthConfigured: true,
      oauthConfigured: true,
      publicBackendOrigin: "beta.example.com",
    });
  });
});
