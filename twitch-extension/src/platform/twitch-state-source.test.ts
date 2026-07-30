import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "./fake-socket.js";
import { TwitchOverlayStateSource } from "./twitch-state-source.js";

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(): { source: TwitchOverlayStateSource; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const source = new TwitchOverlayStateSource(undefined, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return { source, sockets };
}

describe("TwitchOverlayStateSource", () => {
  it("sends a twitch-subscribe message with the connecting channelId + token on open", () => {
    const { source, sockets } = createHarness();
    source.connect({ channelId: "123", authToken: "token-a", mode: "viewer" });
    sockets[0]?.triggerOpen();

    const sent = JSON.parse(sockets[0]?.sentMessages[0] ?? "{}");
    expect(sent).toEqual({ type: "twitch-subscribe", channelId: "123", token: "token-a" });
  });

  it("retains the newest token after updateToken() for the next subscribe attempt", () => {
    const { source } = createHarness();
    source.connect({ channelId: "123", authToken: "token-a", mode: "viewer" });
    expect(source.getPendingSubscribeMessage().token).toBe("token-a");

    // onAuthorized firing again (a routine JWT refresh) must replace the
    // token used by any *future* subscribe attempt, without requiring a
    // fresh connect() call.
    source.updateToken("token-b");
    expect(source.getPendingSubscribeMessage().token).toBe("token-b");
    expect(source.getPendingSubscribeMessage().channelId).toBe("123"); // unaffected by the token refresh
  });

  it("uses the refreshed token (not the stale one) on the actual next reconnect after a drop", () => {
    vi.useFakeTimers();
    const { source, sockets } = createHarness();

    source.connect({ channelId: "123", authToken: "token-a", mode: "viewer" });
    sockets[0]?.triggerOpen();
    source.updateToken("token-b");
    sockets[0]?.close(); // simulate the connection dropping
    vi.advanceTimersByTime(600); // past the initial 500ms backoff

    expect(sockets).toHaveLength(2);
    sockets[1]?.triggerOpen();
    const sentOnReconnect = JSON.parse(sockets[1]?.sentMessages[0] ?? "{}");
    expect(sentOnReconnect.token).toBe("token-b");
  });

  it("stops reconnecting after disconnect()", () => {
    vi.useFakeTimers();
    const { source, sockets } = createHarness();

    source.connect({ channelId: "123", authToken: "token-a", mode: "viewer" });
    sockets[0]?.triggerOpen();
    source.disconnect();
    sockets[0]?.close();
    vi.advanceTimersByTime(5000);

    expect(sockets).toHaveLength(1); // no reconnect attempt after an explicit disconnect
  });
});
