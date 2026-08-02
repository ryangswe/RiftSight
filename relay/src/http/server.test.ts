import { createServer, type Server } from "node:http";
import fetch from "node-fetch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { addToAllowlist } from "../db/allowlist.js";
import { createStateStore, type StateStore } from "../auth/state-store.js";
import { createLinkHandoffStore, type LinkHandoffStore } from "../auth/link-handoff.js";
import type { TwitchOAuthConfig } from "../auth/twitch-oauth.js";
import { createHttpRouter } from "./server.js";

let db: DbClient;
let stateStore: StateStore;
let linkHandoff: LinkHandoffStore;
let httpServer: Server;
let baseUrl: string;

const oauthConfig: TwitchOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://beta.example.com/auth/twitch/callback",
};

async function startServer(deps: Parameters<typeof createHttpRouter>[0]): Promise<void> {
  httpServer = createServer(createHttpRouter(deps));
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://localhost:${port}`;
}

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

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  db.close();
});

describe("createHttpRouter", () => {
  it("GET /health always returns 200 ok", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 ready when the database is reachable", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
  });

  it("GET /auth/twitch/start responds 503 when OAuth isn't configured", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/auth/twitch/start`, { redirect: "manual" });
    expect(response.status).toBe(503);
  });

  it("GET /auth/twitch/start redirects (302) to Twitch when OAuth is configured", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig });
    const response = await fetch(`${baseUrl}/auth/twitch/start`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("id.twitch.tv/oauth2/authorize");
  });

  it("GET /auth/twitch/callback responds 503 when OAuth isn't configured", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/auth/twitch/callback?code=abc&state=xyz`);
    expect(response.status).toBe(503);
  });

  it("GET /auth/twitch/callback rejects an invalid state (400) when OAuth is configured", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig });
    const response = await fetch(`${baseUrl}/auth/twitch/callback?code=abc&state=never-issued`);
    expect(response.status).toBe(400);
  });

  it("GET /api/link-status reports not-found for an unknown linkId", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/api/link-status?linkId=nope`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "not-found" });
  });

  it("POST /api/producer-credential/rotate 401s without a bearer credential", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/api/producer-credential/rotate`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("404s an unknown route", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });
    const response = await fetch(`${baseUrl}/nonexistent`);
    expect(response.status).toBe(404);
  });

  it("end-to-end: a valid OAuth callback with a linkId is pollable via /api/link-status", async () => {
    await addToAllowlist(db, "141981764");
    await startServer({ db, stateStore, linkHandoff, oauthConfig });

    // We can't drive a real Twitch consent screen here, but we can verify
    // the state->linkId wiring reaches all the way to a real HTTP server.
    const startResponse = await fetch(`${baseUrl}/auth/twitch/start?linkId=e2e-link-1`, { redirect: "manual" });
    expect(startResponse.status).toBe(302);

    const statusResponse = await fetch(`${baseUrl}/api/link-status?linkId=e2e-link-1`);
    expect(await statusResponse.json()).toEqual({ status: "pending" });
  });

  it("rate-limits GET /auth/twitch/start after OAUTH_START_LIMIT requests from the same client", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig });

    let lastStatus = 0;
    // OAUTH_START_LIMIT.maxEvents is 20 — issue one more than that.
    for (let i = 0; i < 21; i++) {
      const response = await fetch(`${baseUrl}/auth/twitch/start`, { redirect: "manual" });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("rate-limits POST /api/producer-credential/rotate after CREDENTIAL_ROTATE_LIMIT requests from the same client", async () => {
    await startServer({ db, stateStore, linkHandoff, oauthConfig: undefined });

    let lastStatus = 0;
    // CREDENTIAL_ROTATE_LIMIT.maxEvents is 10 — issue one more than that.
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${baseUrl}/api/producer-credential/rotate`, { method: "POST" });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
