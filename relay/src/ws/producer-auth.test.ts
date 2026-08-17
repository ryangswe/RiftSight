import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { loadMigrations, runMigrations } from "../db/migrate.js";
import { addToAllowlist } from "../db/allowlist.js";
import { linkOrCreateBroadcasterWithIdentity } from "../db/identities.js";
import { issueProducerCredential } from "../db/producer-credentials.js";
import { authenticateProducerUpgrade, extractProducerCredential, isProducerUpgradePath } from "./producer-auth.js";

describe("isProducerUpgradePath", () => {
  it("recognizes the /ws/producer path regardless of query string", () => {
    expect(isProducerUpgradePath("/ws/producer")).toBe(true);
    expect(isProducerUpgradePath("/ws/producer?credential=abc")).toBe(true);
  });

  it("rejects any other path", () => {
    expect(isProducerUpgradePath("/")).toBe(false);
    expect(isProducerUpgradePath("/ws/viewer")).toBe(false);
    expect(isProducerUpgradePath("/ws/producerish")).toBe(false);
  });
});

describe("extractProducerCredential", () => {
  it("reads the credential query param", () => {
    expect(extractProducerCredential("/ws/producer?credential=abc123")).toBe("abc123");
  });

  it("returns undefined when absent", () => {
    expect(extractProducerCredential("/ws/producer")).toBeUndefined();
  });
});

describe("authenticateProducerUpgrade", () => {
  let db: DbClient;
  let broadcasterId: number;

  beforeEach(async () => {
    db = createDbClient(":memory:");
    await runMigrations(db, await loadMigrations());
    await addToAllowlist(db, "141981764");
    const broadcaster = await linkOrCreateBroadcasterWithIdentity(db, "twitch", "141981764", "juicykaraage");
    broadcasterId = broadcaster.broadcasterId;
  });

  afterEach(() => {
    db.close();
  });

  it("authenticates a valid credential and resolves the broadcaster's channel id", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const result = await authenticateProducerUpgrade({ url: `/ws/producer?credential=${token}` } as never, db);
    expect(result).toEqual({ authenticated: true, broadcasterId });
  });

  it("rejects a missing credential", async () => {
    const result = await authenticateProducerUpgrade({ url: "/ws/producer" } as never, db);
    expect(result).toEqual({ authenticated: false, reason: "missing credential" });
  });

  it("rejects an unknown credential", async () => {
    const result = await authenticateProducerUpgrade({ url: "/ws/producer?credential=not-a-real-token" } as never, db);
    expect(result.authenticated).toBe(false);
  });
});
