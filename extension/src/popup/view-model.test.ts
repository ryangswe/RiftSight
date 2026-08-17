import { describe, expect, it } from "vitest";
import { buildStreamView, buildWatchView, type StreamViewInput } from "./view-model.js";
import type { LinkState } from "../background/link-state.js";

const CHANNEL = "UC" + "a".repeat(22);

describe("buildWatchView", () => {
  it("permission missing -> the single enable CTA, regardless of anything else", () => {
    expect(buildWatchView({ permissionGranted: false, overlaysEnabled: true, page: null })).toEqual({ kind: "enable" });
  });

  it("overlays off -> off tone with a turn-on hint", () => {
    const view = buildWatchView({ permissionGranted: true, overlaysEnabled: false, page: null });
    expect(view.kind).toBe("status");
    if (view.kind === "status") {
      expect(view.overlaysOn).toBe(false);
      expect(view.page.tone).toBe("off");
    }
  });

  it("not on YouTube (or a non-watch page) -> quiet open-a-stream hint", () => {
    for (const page of [null, { pageKind: "other" as const, channelId: null, session: "idle" as const }]) {
      const view = buildWatchView({ permissionGranted: true, overlaysEnabled: true, page });
      if (view.kind === "status") expect(view.page.text).toContain("Open a supported YouTube live stream");
    }
  });

  it("VOD watch page -> live-streams-only message, no implied VOD support", () => {
    const view = buildWatchView({
      permissionGranted: true,
      overlaysEnabled: true,
      page: { pageKind: "vod-watch", channelId: null, session: "idle" },
    });
    if (view.kind === "status") expect(view.page.text).toContain("live streams");
  });

  it("live stream with active session -> green active line", () => {
    const view = buildWatchView({
      permissionGranted: true,
      overlaysEnabled: true,
      page: { pageKind: "live-watch", channelId: CHANNEL, session: "active" },
    });
    if (view.kind === "status") {
      expect(view.page.tone).toBe("on");
      expect(view.page.text).toContain("active");
    }
  });

  it("live stream the relay rejected -> quiet unavailable, no error language", () => {
    const view = buildWatchView({
      permissionGranted: true,
      overlaysEnabled: true,
      page: { pageKind: "live-watch", channelId: CHANNEL, session: "unavailable" },
    });
    if (view.kind === "status") {
      expect(view.page.tone).toBe("off");
      expect(view.page.text).not.toMatch(/error|fail/i);
    }
  });
});

function streamInput(overrides: Partial<StreamViewInput> = {}): StreamViewInput {
  const link: LinkState = { status: "not-connected", displayName: undefined, platform: undefined };
  return {
    link,
    presence: "no-riftatlas",
    publishingIntent: false,
    relayStatus: "disconnected",
    producerReplaced: false,
    viewerCount: undefined,
    youtubeClaim: "unknown",
    ...overrides,
  };
}

describe("buildStreamView", () => {
  it("unauthenticated: both platform rows independently connectable, primary disabled", () => {
    const view = buildStreamView(streamInput());
    expect(view.linked).toBe(false);
    expect(view.twitch).toEqual({ state: "not-connected", detail: null, connectable: true });
    expect(view.youtube).toEqual({ state: "not-connected", detail: null, connectable: true });
    expect(view.primary.enabled).toBe(false);
  });

  it("linked via Twitch: twitch row connected with display name, youtube row from the claim", () => {
    const view = buildStreamView(
      streamInput({
        link: { status: "connected", displayName: "juicykaraage", platform: "twitch" },
        youtubeClaim: { channelId: CHANNEL, displayName: "My Channel" },
      })
    );
    expect(view.twitch.state).toBe("connected");
    expect(view.twitch.detail).toBe("juicykaraage");
    expect(view.youtube.state).toBe("connected");
    expect(view.youtube.detail).toBe("My Channel");
  });

  it("linked via YouTube ONLY: youtube row connected, twitch row honest coming-soon — never a Twitch requirement", () => {
    const view = buildStreamView(
      streamInput({ link: { status: "connected", displayName: "My Channel", platform: "youtube" } })
    );
    expect(view.linked).toBe(true);
    expect(view.youtube.state).toBe("connected");
    expect(view.youtube.detail).toBe("My Channel");
    expect(view.twitch.state).toBe("coming-soon");
    expect(view.primary.enabled).toBe(true); // fully operational with zero Twitch
  });

  it("publishing while live shows viewers; stop is the primary action", () => {
    const view = buildStreamView(
      streamInput({
        link: { status: "connected", displayName: "x", platform: "twitch" },
        presence: "active",
        publishingIntent: true,
        relayStatus: "connected",
        viewerCount: 12,
      })
    );
    expect(view.publishing.tone).toBe("on");
    expect(view.publishing.text).toContain("12 viewers");
    expect(view.primary).toEqual({ label: "Stop publishing", action: "stop", enabled: true });
  });

  it("intent on but Rift Atlas missing -> waiting tone, not a false Live", () => {
    const view = buildStreamView(
      streamInput({
        link: { status: "connected", displayName: "x", platform: "twitch" },
        presence: "no-riftatlas",
        publishingIntent: true,
        relayStatus: "connected",
      })
    );
    expect(view.publishing.tone).toBe("waiting");
    expect(view.atlas.tone).toBe("off");
  });

  it("beta rejection and expired credentials surface as the notice line", () => {
    for (const status of ["not-in-beta", "credential-expired"] as const) {
      const view = buildStreamView(streamInput({ link: { status, displayName: undefined, platform: "twitch" } }));
      expect(view.notice).not.toBeNull();
    }
  });

  it("producer replacement is warned about exactly once (notice), with a warn publishing tone", () => {
    const view = buildStreamView(
      streamInput({
        link: { status: "connected", displayName: "x", platform: "twitch" },
        presence: "active",
        publishingIntent: true,
        relayStatus: "connected",
        producerReplaced: true,
      })
    );
    expect(view.publishing.tone).toBe("warn");
    expect(view.notice).toContain("took over");
  });
});
