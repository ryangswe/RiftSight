import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import { upsertBroadcaster } from "./broadcasters.js";
import { addToAllowlist, removeFromAllowlist } from "./allowlist.js";
import { issueProducerCredential, revokeAllCredentialsForBroadcaster, rotateProducerCredential, validateProducerCredential } from "./producer-credentials.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

let db: DbClient;
let broadcasterId: number;

beforeEach(async () => {
  db = createDbClient(":memory:");
  const migrations = await Promise.all(
    ["0001_init.sql", "0002_producer_credentials.sql"].map(async (file, index) => ({
      version: index + 1,
      name: file,
      sql: await readFile(path.join(migrationsDir, file), "utf8"),
    }))
  );
  await runMigrations(db, migrations);

  await addToAllowlist(db, "141981764");
  const broadcaster = await upsertBroadcaster(db, "141981764", "juicykaraage");
  broadcasterId = broadcaster.id;
});

afterEach(() => {
  db.close();
});

describe("issueProducerCredential + validateProducerCredential", () => {
  it("a freshly issued credential validates to the correct broadcaster/channel", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const result = await validateProducerCredential(db, token);
    expect(result).toEqual({ broadcasterId, twitchUserId: "141981764" });
  });

  it("an unknown/garbage token does not validate", async () => {
    expect(await validateProducerCredential(db, "not-a-real-token")).toBeNull();
  });

  it("stores only the hash, never the raw token, in the database", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const rows = await db.execute("SELECT token_hash FROM producer_credentials");
    expect(rows.rows[0]?.["token_hash"]).not.toBe(token);
  });
});

describe("revokeAllCredentialsForBroadcaster", () => {
  it("a revoked credential no longer validates", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await revokeAllCredentialsForBroadcaster(db, broadcasterId);
    expect(await validateProducerCredential(db, token)).toBeNull();
  });

  it("only revokes the given broadcaster's credentials, not others'", async () => {
    await addToAllowlist(db, "222");
    const other = await upsertBroadcaster(db, "222", "other_streamer");
    const tokenA = await issueProducerCredential(db, broadcasterId);
    const tokenB = await issueProducerCredential(db, other.id);

    await revokeAllCredentialsForBroadcaster(db, broadcasterId);

    expect(await validateProducerCredential(db, tokenA)).toBeNull();
    expect(await validateProducerCredential(db, tokenB)).not.toBeNull();
  });
});

describe("rotateProducerCredential", () => {
  it("the old credential stops validating and a new one starts working", async () => {
    const oldToken = await issueProducerCredential(db, broadcasterId);
    const newToken = await rotateProducerCredential(db, broadcasterId);

    expect(oldToken).not.toBe(newToken);
    expect(await validateProducerCredential(db, oldToken)).toBeNull();
    expect(await validateProducerCredential(db, newToken)).toEqual({ broadcasterId, twitchUserId: "141981764" });
  });
});

describe("allowlist removal blocks producer credential validation (no separate revocation step needed)", () => {
  it("a valid, non-revoked credential stops validating once its broadcaster is removed from the allowlist", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    expect(await validateProducerCredential(db, token)).not.toBeNull();

    await removeFromAllowlist(db, "141981764");

    expect(await validateProducerCredential(db, token)).toBeNull();
  });

  it("re-adding to the allowlist restores validation for the same still-unrevoked credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await removeFromAllowlist(db, "141981764");
    expect(await validateProducerCredential(db, token)).toBeNull();

    await addToAllowlist(db, "141981764");
    expect(await validateProducerCredential(db, token)).not.toBeNull();
  });
});
