import { describe, expect, it } from "vitest";
import { buildPlatformContext } from "./twitch-context.js";

describe("buildPlatformContext", () => {
  it("maps Twitch's auth object fields to ViewerPlatformContext", () => {
    const auth = { channelId: "123456789", clientId: "client-abc", token: "jwt-token", helixToken: "helix-token", userId: "U1" };
    expect(buildPlatformContext(auth)).toEqual({ channelId: "123456789", authToken: "jwt-token", mode: "viewer" });
  });

  it("defaults mode to viewer but allows overriding it (e.g. for a config page)", () => {
    const auth = { channelId: "123", clientId: "c", token: "t", helixToken: "h", userId: "U1" };
    expect(buildPlatformContext(auth, "config").mode).toBe("config");
  });

  it("never derives channelId from anything other than the auth object", () => {
    const auth = { channelId: "the-real-channel", clientId: "c", token: "t", helixToken: "h", userId: "U1" };
    const context = buildPlatformContext(auth);
    expect(context.channelId).toBe("the-real-channel");
    expect(Object.keys(context)).toEqual(["channelId", "authToken", "mode"]);
  });
});
