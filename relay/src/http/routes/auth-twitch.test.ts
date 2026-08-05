import { Response } from "node-fetch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { addToAllowlist } from "../../db/allowlist.js";
import { getBroadcasterByTwitchUserId } from "../../db/broadcasters.js";
import { validateProducerCredential } from "../../db/producer-credentials.js";
import { createStateStore, type StateStore } from "../../auth/state-store.js";
import { createLinkHandoffStore, type LinkHandoffStore } from "../../auth/link-handoff.js";
import type { FetchLike, TwitchOAuthConfig } from "../../auth/twitch-oauth.js";
import { handleAuthCallback, handleAuthStart } from "./auth-twitch.js";

const config: TwitchOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://beta.example.com/auth/twitch/callback",
};

let db: DbClient;
let stateStore: StateStore;
let linkHandoff: LinkHandoffStore;

beforeEach(async () => {
  db = createDbClient(":memory:");
  await runMigrations(db, [
    {
      version: 1,
      name: "init",
      sql: `
        CREATE TABLE broadcasters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          twitch_user_id TEXT NOT NULL UNIQUE,
          twitch_login TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE twitch_allowlist (
          twitch_user_id TEXT PRIMARY KEY,
          added_at TEXT NOT NULL,
          note TEXT
        );
      `,
    },
    {
      version: 2,
      name: "producer_credentials",
      sql: `
        CREATE TABLE producer_credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          broadcaster_id INTEGER NOT NULL REFERENCES broadcasters(id),
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
      `,
    },
  ]);
  stateStore = createStateStore();
  linkHandoff = createLinkHandoffStore();
});

afterEach(() => {
  db.close();
});

function successfulFetch(userId: string, login: string): FetchLike {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) {
      return new Response(JSON.stringify({ access_token: "access-123", refresh_token: "r", expires_in: 100, scope: [], token_type: "bearer" }), { status: 200 });
    }
    return new Response(JSON.stringify({ user_id: userId, login }), { status: 200 });
  };
}

describe("handleAuthStart", () => {
  it("redirects (302) to Twitch's authorize URL with a freshly issued state", () => {
    const req = { method: "GET", url: "/auth/twitch/start", headers: {} };
    const response = handleAuthStart(req, config, stateStore, linkHandoff);
    expect(response.status).toBe(302);
    const location = response.headers?.["Location"];
    expect(location).toBeDefined();
    const url = new URL(location as string);
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    const issuedState = url.searchParams.get("state") as string;
    expect(stateStore.consume(issuedState).valid).toBe(true);
  });

  it("without a linkId query param, issues state with no associated linkId (manual/dev linking)", () => {
    const req = { method: "GET", url: "/auth/twitch/start", headers: {} };
    const response = handleAuthStart(req, config, stateStore, linkHandoff);
    const url = new URL(response.headers?.["Location"] as string);
    const issuedState = url.searchParams.get("state") as string;
    expect(stateStore.consume(issuedState).linkId).toBeUndefined();
  });

  it("with a linkId query param, marks it pending and associates it with the issued state", () => {
    const req = { method: "GET", url: "/auth/twitch/start?linkId=ext-link-1", headers: {} };
    const response = handleAuthStart(req, config, stateStore, linkHandoff);
    expect(linkHandoff.status("ext-link-1")).toBe("pending");
    const url = new URL(response.headers?.["Location"] as string);
    const issuedState = url.searchParams.get("state") as string;
    expect(stateStore.consume(issuedState).linkId).toBe("ext-link-1");
  });
});

describe("handleAuthCallback", () => {
  it("links a beta-allowed account: 200, creates the broadcaster row", async () => {
    await addToAllowlist(db, "141981764");
    const state = stateStore.issue();
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") });

    expect(response.status).toBe(200);
    expect(response.body).toContain("juicykaraage");
    const broadcaster = await getBroadcasterByTwitchUserId(db, "141981764");
    expect(broadcaster?.twitchLogin).toBe("juicykaraage");
  });

  it("with a linkId, issues a producer credential and marks the handoff store ready", async () => {
    await addToAllowlist(db, "141981764");
    const state = stateStore.issue("ext-link-1");
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") });

    expect(linkHandoff.status("ext-link-1")).toBe("ready");
    const result = linkHandoff.redeem("ext-link-1");
    expect(result).toBeDefined();
    expect(result?.displayName).toBe("juicykaraage");
    const validated = await validateProducerCredential(db, result?.credential as string);
    expect(validated?.twitchUserId).toBe("141981764");
  });

  it("without a linkId, no credential is issued and no handoff entry is touched", async () => {
    await addToAllowlist(db, "141981764");
    const state = stateStore.issue(); // no linkId
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") });

    const all = await db.execute("SELECT * FROM producer_credentials");
    expect(all.rows.length).toBe(0);
  });

  it("rejects an account not on the beta allowlist: 403, no broadcaster row created, no credential issued, handoff marked rejected", async () => {
    const state = stateStore.issue("ext-link-1");
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("999999", "not_approved") });

    expect(response.status).toBe(403);
    expect(await getBroadcasterByTwitchUserId(db, "999999")).toBeNull();
    // Distinct from "not-found" — the extension can tell "you're not in the
    // beta" apart from "the link attempt merely expired" and show a
    // specific message instead of silently timing out after 5 minutes.
    expect(linkHandoff.status("ext-link-1")).toBe("rejected");
    expect(linkHandoff.redeem("ext-link-1")).toBeUndefined();
  });

  it("rejects an account not on the beta allowlist with no linkId: 403, no handoff entry touched at all", async () => {
    const state = stateStore.issue(); // no linkId — manual/dev linking
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("999999", "not_approved") });

    expect(response.status).toBe(403);
  });

  it("handles a denied authorization (Twitch's error param): 400", async () => {
    const req = { method: "GET", url: "/auth/twitch/callback?error=access_denied", headers: {} };
    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db });
    expect(response.status).toBe(400);
  });

  it("rejects a callback missing code or state: 400", async () => {
    const req1 = { method: "GET", url: "/auth/twitch/callback?state=abc", headers: {} };
    const req2 = { method: "GET", url: "/auth/twitch/callback?code=abc", headers: {} };
    expect((await handleAuthCallback(req1, { config, stateStore, linkHandoff, db })).status).toBe(400);
    expect((await handleAuthCallback(req2, { config, stateStore, linkHandoff, db })).status).toBe(400);
  });

  it("rejects an invalid or already-used state: 400", async () => {
    const req = { method: "GET", url: "/auth/twitch/callback?code=abc&state=never-issued", headers: {} };
    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db });
    expect(response.status).toBe(400);
  });

  it("rejects a reused state (single-use, even for a valid prior state)", async () => {
    await addToAllowlist(db, "141981764");
    const state = stateStore.issue();
    const req = { method: "GET", url: `/auth/twitch/callback?code=abc&state=${state}`, headers: {} };

    const first = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") });
    expect(first.status).toBe(200);

    const second = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: successfulFetch("141981764", "juicykaraage") });
    expect(second.status).toBe(400);
  });

  it("returns 400 when the token exchange itself fails", async () => {
    const state = stateStore.issue();
    const req = { method: "GET", url: `/auth/twitch/callback?code=bad&state=${state}`, headers: {} };
    const failingFetch: FetchLike = async () => new Response(JSON.stringify({ error: "invalid code" }), { status: 400 });

    const response = await handleAuthCallback(req, { config, stateStore, linkHandoff, db, fetchFn: failingFetch });
    expect(response.status).toBe(400);
  });
});
