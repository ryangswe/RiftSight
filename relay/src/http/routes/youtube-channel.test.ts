import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { addToAllowlist } from "../../db/allowlist.js";
import { linkOrCreateBroadcasterWithIdentity } from "../../db/identities.js";
import { issueProducerCredential } from "../../db/producer-credentials.js";
import { handleClearYouTubeChannel, handleGetYouTubeChannel, handleSetYouTubeChannel } from "./youtube-channel.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

const CHANNEL_A = "UC" + "a".repeat(22);
const CHANNEL_B = "UC" + "b".repeat(22);

let db: DbClient;
let credential: string;
let otherCredential: string;

beforeEach(async () => {
  db = createDbClient(":memory:");
  const migrations = await Promise.all(
    ["0001_init.sql", "0002_producer_credentials.sql", "0003_producer_credential_lifecycle.sql", "0004_youtube_channels.sql", "0005_platform_identities.sql"].map(
      async (file, index) => ({
        version: index + 1,
        name: file,
        sql: await readFile(path.join(migrationsDir, file), "utf8"),
      })
    )
  );
  await runMigrations(db, migrations);

  await addToAllowlist(db, "141981764");
  const broadcaster = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "141981764", "juicykaraage");
  credential = await issueProducerCredential(db, broadcaster.broadcasterId);

  await addToAllowlist(db, "555555");
  const other = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "555555", "other_streamer");
  otherCredential = await issueProducerCredential(db, other.broadcasterId);
});

afterEach(() => {
  db.close();
});

function request(method: string, url: string, token?: string) {
  return { method, url, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe("handleSetYouTubeChannel", () => {
  it("401s without a bearer credential", async () => {
    const response = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`), db);
    expect(response.status).toBe(401);
  });

  it("401s with an unknown credential", async () => {
    const response = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, "nope"), db);
    expect(response.status).toBe(401);
  });

  it("400s on a non-canonical channel id (handle, URL, wrong length, missing)", async () => {
    for (const bad of ["@handle", "youtube.com%2Fchannel%2FUCx", "UCshort", ""]) {
      const response = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${bad}`, credential), db);
      expect(response.status).toBe(400);
    }
  });

  it("claims a channel and reads it back", async () => {
    const set = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, credential), db);
    expect(set.status).toBe(200);
    expect(JSON.parse(set.body)).toEqual({ channelId: CHANNEL_A });

    const get = await handleGetYouTubeChannel(request("GET", "/api/youtube-channel", credential), db);
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual({ channelId: CHANNEL_A, displayName: null });
  });

  it("409s when another broadcaster already claimed the channel", async () => {
    await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, credential), db);
    const conflict = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, otherCredential), db);
    expect(conflict.status).toBe(409);
  });

  it("re-claiming your own channel and replacing it both succeed", async () => {
    await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, credential), db);
    const again = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, credential), db);
    expect(again.status).toBe(200);
    const replaced = await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_B}`, credential), db);
    expect(replaced.status).toBe(200);
    const get = await handleGetYouTubeChannel(request("GET", "/api/youtube-channel", credential), db);
    expect(JSON.parse(get.body)).toEqual({ channelId: CHANNEL_B, displayName: null });
  });
});

describe("handleGetYouTubeChannel", () => {
  it("reports null before any claim", async () => {
    const response = await handleGetYouTubeChannel(request("GET", "/api/youtube-channel", credential), db);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ channelId: null, displayName: null });
  });

  it("401s without a credential", async () => {
    const response = await handleGetYouTubeChannel(request("GET", "/api/youtube-channel"), db);
    expect(response.status).toBe(401);
  });
});

describe("handleClearYouTubeChannel", () => {
  it("clears an existing claim", async () => {
    await handleSetYouTubeChannel(request("POST", `/api/youtube-channel?channelId=${CHANNEL_A}`, credential), db);
    const cleared = await handleClearYouTubeChannel(request("DELETE", "/api/youtube-channel", credential), db);
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body)).toEqual({ channelId: null });
    const get = await handleGetYouTubeChannel(request("GET", "/api/youtube-channel", credential), db);
    expect(JSON.parse(get.body)).toEqual({ channelId: null, displayName: null });
  });

  it("clearing when nothing is set is a harmless 200", async () => {
    const cleared = await handleClearYouTubeChannel(request("DELETE", "/api/youtube-channel", credential), db);
    expect(cleared.status).toBe(200);
  });

  it("401s without a credential", async () => {
    const response = await handleClearYouTubeChannel(request("DELETE", "/api/youtube-channel"), db);
    expect(response.status).toBe(401);
  });
});
