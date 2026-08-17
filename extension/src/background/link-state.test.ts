import { describe, expect, it } from "vitest";
import { INITIAL_LINK_STATE, reduceLinkState, type LinkState } from "./link-state.js";

describe("reduceLinkState", () => {
  it("starts as not-connected with no display name", () => {
    expect(INITIAL_LINK_STATE).toEqual({ status: "not-connected", displayName: undefined, platform: undefined });
  });

  it("start-link moves to connecting and clears any prior display name", () => {
    const state: LinkState = { status: "credential-expired", displayName: "old_name", platform: "twitch" };
    expect(reduceLinkState(state, { type: "start-link", platform: "twitch" })).toEqual({ status: "connecting", displayName: undefined, platform: "twitch" });
  });

  it("poll-pending moves to waiting-for-authorization", () => {
    const state: LinkState = { status: "connecting", displayName: undefined, platform: "youtube" };
    expect(reduceLinkState(state, { type: "poll-pending" })).toEqual({ status: "waiting-for-authorization", displayName: undefined, platform: "youtube" });
  });

  it("poll-ready moves to connected with the given display name", () => {
    const state: LinkState = { status: "waiting-for-authorization", displayName: undefined, platform: "twitch" };
    expect(reduceLinkState(state, { type: "poll-ready", displayName: "juicykaraage" })).toEqual({
      status: "connected",
      displayName: "juicykaraage",
      platform: "twitch",
    });
  });

  it("poll-not-found resets to not-connected (link attempt expired or was never valid)", () => {
    const state: LinkState = { status: "waiting-for-authorization", displayName: undefined, platform: "twitch" };
    expect(reduceLinkState(state, { type: "poll-not-found" })).toEqual({ status: "not-connected", displayName: undefined, platform: undefined });
  });

  it("poll-rejected moves to not-in-beta (backend determined the account isn't allowlisted)", () => {
    const state: LinkState = { status: "waiting-for-authorization", displayName: undefined, platform: "twitch" };
    expect(reduceLinkState(state, { type: "poll-rejected" })).toEqual({ status: "not-in-beta", displayName: undefined, platform: "twitch" });
  });

  it("poll-error moves to backend-unavailable, preserving a prior display name", () => {
    const state: LinkState = { status: "connected", displayName: "juicykaraage", platform: "twitch" };
    expect(reduceLinkState(state, { type: "poll-error" })).toEqual({ status: "backend-unavailable", displayName: "juicykaraage", platform: "twitch" });
  });

  it("disconnect always resets to not-connected, clearing the display name", () => {
    const state: LinkState = { status: "connected", displayName: "juicykaraage", platform: "twitch" };
    expect(reduceLinkState(state, { type: "disconnect" })).toEqual({ status: "not-connected", displayName: undefined, platform: undefined });
  });

  it("credential-rejected moves to credential-expired, preserving the display name", () => {
    const state: LinkState = { status: "connected", displayName: "juicykaraage", platform: "twitch" };
    expect(reduceLinkState(state, { type: "credential-rejected" })).toEqual({ status: "credential-expired", displayName: "juicykaraage", platform: "twitch" });
  });
});
