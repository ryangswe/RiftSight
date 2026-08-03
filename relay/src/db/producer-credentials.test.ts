import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import { upsertBroadcaster } from "./broadcasters.js";
import { addToAllowlist, removeFromAllowlist } from "./allowlist.js";
import {
  inspectProducerCredential,
  issueProducerCredential,
  listCredentialLifecycleForBroadcaster,
  revokeAllCredentialsForBroadcaster,
  rotateProducerCredential,
  touchProducerCredentialLastUsed,
  validateProducerCredential,
} from "./producer-credentials.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

let db: DbClient;
let broadcasterId: number;

beforeEach(async () => {
  db = createDbClient(":memory:");
  const migrations = await Promise.all(
    ["0001_init.sql", "0002_producer_credentials.sql", "0003_producer_credential_lifecycle.sql"].map(async (file, index) => ({
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

describe("inspectProducerCredential", () => {
  it("reports \"valid\" for a valid, non-revoked, still-allowlisted credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    expect(await inspectProducerCredential(db, token)).toBe("valid");
  });

  it("reports \"invalid_or_malformed\" for a token that was never issued", async () => {
    expect(await inspectProducerCredential(db, "not-a-real-token")).toBe("invalid_or_malformed");
  });

  it("reports \"revoked_or_replaced\" for an explicitly revoked credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await revokeAllCredentialsForBroadcaster(db, broadcasterId);
    expect(await inspectProducerCredential(db, token)).toBe("revoked_or_replaced");
  });

  it("reports \"revoked_or_replaced\" for a credential replaced via rotation", async () => {
    const oldToken = await issueProducerCredential(db, broadcasterId);
    await rotateProducerCredential(db, broadcasterId);
    expect(await inspectProducerCredential(db, oldToken)).toBe("revoked_or_replaced");
  });

  it("reports \"not_allowlisted\" for a valid, non-revoked credential whose broadcaster was removed from the allowlist", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await removeFromAllowlist(db, "141981764");
    expect(await inspectProducerCredential(db, token)).toBe("not_allowlisted");
  });

  it("distinguishes revoked from not-allowlisted — revocation is checked first and wins even if both are true", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await revokeAllCredentialsForBroadcaster(db, broadcasterId);
    await removeFromAllowlist(db, "141981764");
    expect(await inspectProducerCredential(db, token)).toBe("revoked_or_replaced");
  });

  it("never reveals anything about a different broadcaster's credential", async () => {
    await addToAllowlist(db, "222");
    const other = await upsertBroadcaster(db, "222", "other_streamer");
    const otherToken = await issueProducerCredential(db, other.id);

    // Inspecting broadcasterId's own (nonexistent) guess at another
    // credential's shape must never succeed — only a token that actually
    // hashes to a stored row resolves to anything but invalid_or_malformed.
    expect(await inspectProducerCredential(db, "some-other-guess")).toBe("invalid_or_malformed");
    expect(await inspectProducerCredential(db, otherToken)).toBe("valid");
  });
});

describe("rotation timestamps", () => {
  it("rotation sets both revoked_at and rotated_at on the superseded credential, and neither on the new one", async () => {
    const oldToken = await issueProducerCredential(db, broadcasterId);
    await rotateProducerCredential(db, broadcasterId);

    const rows = await db.execute("SELECT token_hash, revoked_at, rotated_at FROM producer_credentials ORDER BY id");
    expect(rows.rows).toHaveLength(2);
    const [oldRow, newRow] = rows.rows;
    expect(oldRow?.["revoked_at"]).not.toBeNull();
    expect(oldRow?.["rotated_at"]).not.toBeNull();
    expect(newRow?.["revoked_at"]).toBeNull();
    expect(newRow?.["rotated_at"]).toBeNull();
    void oldToken; // only used to establish there WAS a prior credential to rotate away from
  });

  it("a plain revokeAllCredentialsForBroadcaster call never sets rotated_at — only rotation does", async () => {
    await issueProducerCredential(db, broadcasterId);
    await revokeAllCredentialsForBroadcaster(db, broadcasterId);

    const rows = await db.execute("SELECT revoked_at, rotated_at FROM producer_credentials");
    expect(rows.rows[0]?.["revoked_at"]).not.toBeNull();
    expect(rows.rows[0]?.["rotated_at"]).toBeNull();
  });
});

describe("touchProducerCredentialLastUsed", () => {
  it("sets last_used_at on the matching credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const before = await db.execute("SELECT last_used_at FROM producer_credentials");
    expect(before.rows[0]?.["last_used_at"]).toBeNull();

    await touchProducerCredentialLastUsed(db, token);

    const after = await db.execute("SELECT last_used_at FROM producer_credentials");
    expect(after.rows[0]?.["last_used_at"]).not.toBeNull();
  });

  it("is a safe no-op for a token that doesn't resolve to anything", async () => {
    await expect(touchProducerCredentialLastUsed(db, "not-a-real-token")).resolves.toBeUndefined();
  });
});

describe("listCredentialLifecycleForBroadcaster", () => {
  it("reports issuedAt for a freshly issued credential with everything else null and active true", async () => {
    await issueProducerCredential(db, broadcasterId);
    const [entry] = await listCredentialLifecycleForBroadcaster(db, "141981764");
    expect(entry).toBeDefined();
    expect(entry!.issuedAt).toEqual(expect.any(String));
    expect(entry!.lastUsedAt).toBeNull();
    expect(entry!.rotatedAt).toBeNull();
    expect(entry!.revokedAt).toBeNull();
    expect(entry!.active).toBe(true);
  });

  it("lists most-recent-first and marks a rotated-away credential inactive", async () => {
    const oldToken = await issueProducerCredential(db, broadcasterId);
    await touchProducerCredentialLastUsed(db, oldToken);
    await rotateProducerCredential(db, broadcasterId);

    const entries = await listCredentialLifecycleForBroadcaster(db, "141981764");
    expect(entries).toHaveLength(2);
    const [newest, oldest] = entries;
    expect(newest!.active).toBe(true);
    expect(newest!.rotatedAt).toBeNull();
    expect(oldest!.active).toBe(false);
    expect(oldest!.rotatedAt).not.toBeNull();
    expect(oldest!.lastUsedAt).not.toBeNull();
  });

  it("never includes a token hash or any field resembling one", async () => {
    await issueProducerCredential(db, broadcasterId);
    const [entry] = await listCredentialLifecycleForBroadcaster(db, "141981764");
    const keys = Object.keys(entry!);
    expect(keys.some((key) => key.toLowerCase().includes("hash"))).toBe(false);
    expect(keys.some((key) => key.toLowerCase().includes("token"))).toBe(false);
  });

  it("returns an empty array for a twitch user id with no credentials at all", async () => {
    expect(await listCredentialLifecycleForBroadcaster(db, "999999")).toEqual([]);
  });

  it("only reports the requested broadcaster's own credentials", async () => {
    await addToAllowlist(db, "222");
    const other = await upsertBroadcaster(db, "222", "other_streamer");
    await issueProducerCredential(db, broadcasterId);
    await issueProducerCredential(db, other.id);

    const entries = await listCredentialLifecycleForBroadcaster(db, "141981764");
    expect(entries).toHaveLength(1);
  });
});
