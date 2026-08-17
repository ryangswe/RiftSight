import { Response } from "node-fetch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { loadMigrations, runMigrations } from "../../db/migrate.js";
import { addToYouTubeAllowlist } from "../../db/allowlist.js";
import { findIdentity, linkOrCreateBroadcasterWithIdentity, listIdentitiesForBroadcaster } from "../../db/identities.js";
import { validateProducerCredential } from "../../db/producer-credentials.js";
import { createStateStore, type StateStore } from "../../auth/state-store.js";
import { createLinkHandoffStore, type LinkHandoffStore } from "../../auth/link-handoff.js";
import type { FetchLike } from "../../auth/twitch-oauth.js";
import type { GoogleOAuthConfig } from "../../auth/google-oauth.js";
import { handleGoogleAuthCallback, handleGoogleAuthStart } from "./auth-google.js";

const config: GoogleOAuthConfig = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  redirectUri: "https://beta.example.com/auth/google/callback",
};

const CHANNEL = "UC" + "a".repeat(22);

let db: DbClient;
let stateStore: StateStore;
let linkHandoff: LinkHandoffStore;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, await loadMigrations());
  stateStore = createStateStore();
  linkHandoff = createLinkHandoffStore();
});

afterEach(() => {
  db.close();
});

/** Fake Google: token exchange succeeds, channels?mine=true returns the given channel (or none). */
function googleFetch(channel: { id: string; title: string } | null): FetchLike {
  return async (url) => {
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "fake-access-token" }), { status: 200 });
    }
    if (url.includes("/youtube/v3/channels")) {
      const items = channel ? [{ id: channel.id, snippet: { title: channel.title } }] : [];
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe("handleGoogleAuthStart", () => {
  it("redirects to Google's consent screen with the youtube.readonly scope and a consumable state", () => {
    const response = handleGoogleAuthStart({ method: "GET", url: "/auth/google/start?linkId=yt-link-1", headers: {} }, config, stateStore, linkHandoff);
    expect(response.status).toBe(302);
    const url = new URL(response.headers?.["Location"] as string);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("youtube.readonly");
    expect(linkHandoff.status("yt-link-1")).toBe("pending");
    expect(stateStore.consume(url.searchParams.get("state") as string).linkId).toBe("yt-link-1");
  });
});

describe("handleGoogleAuthCallback", () => {
  function callbackRequest(state: string) {
    return { method: "GET", url: `/auth/google/callback?code=abc&state=${state}`, headers: {} };
  }

  it("a YouTube-only streamer onboards end to end with no Twitch anything: broadcaster created, verified channel linked, credential issued and valid", async () => {
    await addToYouTubeAllowlist(db, CHANNEL);
    const state = stateStore.issue("yt-link-1");

    const response = await handleGoogleAuthCallback(callbackRequest(state), {
      config,
      stateStore,
      linkHandoff,
      db,
      fetchFn: googleFetch({ id: CHANNEL, title: "My Stream Channel" }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain("My Stream Channel");

    const identity = await findIdentity(db, "youtube", CHANNEL);
    expect(identity?.displayName).toBe("My Stream Channel");
    expect(await listIdentitiesForBroadcaster(db, identity!.broadcasterId)).toHaveLength(1); // youtube only — no twitch row

    const redeemed = linkHandoff.redeem("yt-link-1");
    expect(redeemed?.displayName).toBe("My Stream Channel");
    const validated = await validateProducerCredential(db, redeemed!.credential);
    expect(validated?.broadcasterId).toBe(identity!.broadcasterId);
  });

  it("resolves to the SAME broadcaster when the channel was already linked (e.g. via the manual beta claim) instead of creating a duplicate", async () => {
    await addToYouTubeAllowlist(db, CHANNEL);
    const existing = await linkOrCreateBroadcasterWithIdentity(db, "youtube", CHANNEL, null);
    const state = stateStore.issue();

    await handleGoogleAuthCallback(callbackRequest(state), {
      config,
      stateStore,
      linkHandoff,
      db,
      fetchFn: googleFetch({ id: CHANNEL, title: "Verified Title" }),
    });

    const identity = await findIdentity(db, "youtube", CHANNEL);
    expect(identity?.broadcasterId).toBe(existing.broadcasterId);
    expect(identity?.displayName).toBe("Verified Title"); // verification upgraded the display name
  });

  it("rejects a channel not on the youtube beta allowlist: 403, no identity created, handoff rejected", async () => {
    const state = stateStore.issue("yt-link-2");
    const response = await handleGoogleAuthCallback(callbackRequest(state), {
      config,
      stateStore,
      linkHandoff,
      db,
      fetchFn: googleFetch({ id: CHANNEL, title: "Not Approved" }),
    });

    expect(response.status).toBe(403);
    expect(await findIdentity(db, "youtube", CHANNEL)).toBeNull();
    expect(linkHandoff.status("yt-link-2")).toBe("rejected");
  });

  it("a Google account with no YouTube channel gets a specific message, not a link", async () => {
    const state = stateStore.issue("yt-link-3");
    const response = await handleGoogleAuthCallback(callbackRequest(state), {
      config,
      stateStore,
      linkHandoff,
      db,
      fetchFn: googleFetch(null),
    });

    expect(response.status).toBe(400);
    expect(response.body).toContain("doesn't have a YouTube channel");
    expect(linkHandoff.status("yt-link-3")).toBe("rejected");
  });

  it("rejects an invalid/expired state", async () => {
    const response = await handleGoogleAuthCallback(callbackRequest("bogus-state"), {
      config,
      stateStore,
      linkHandoff,
      db,
      fetchFn: googleFetch({ id: CHANNEL, title: "x" }),
    });
    expect(response.status).toBe(400);
  });
});
