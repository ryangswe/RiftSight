import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { addToAllowlist } from "../../db/allowlist.js";
import { upsertBroadcaster } from "../../db/broadcasters.js";
import { issueProducerCredential, revokeAllCredentialsForBroadcaster, validateProducerCredential } from "../../db/producer-credentials.js";
import { removeFromAllowlist } from "../../db/allowlist.js";
import { createLinkHandoffStore, type LinkHandoffStore } from "../../auth/link-handoff.js";
import { handleLinkStatus, handleProducerCredentialStatus, handleRotateProducerCredential } from "./producer-credential.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

let db: DbClient;
let linkHandoff: LinkHandoffStore;
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
  linkHandoff = createLinkHandoffStore();

  await addToAllowlist(db, "141981764");
  const broadcaster = await upsertBroadcaster(db, "141981764", "juicykaraage");
  broadcasterId = broadcaster.id;
});

afterEach(() => {
  db.close();
});

describe("handleLinkStatus", () => {
  it("400s when linkId is missing", () => {
    const req = { method: "GET", url: "/api/link-status", headers: {} };
    const response = handleLinkStatus(req, linkHandoff);
    expect(response.status).toBe(400);
  });

  it("reports not-found for an unknown linkId", () => {
    const req = { method: "GET", url: "/api/link-status?linkId=nope", headers: {} };
    const response = handleLinkStatus(req, linkHandoff);
    expect(JSON.parse(response.body)).toEqual({ status: "not-found" });
  });

  it("reports pending while the linkId is still waiting on the OAuth callback", () => {
    linkHandoff.markPending("link-1");
    const req = { method: "GET", url: "/api/link-status?linkId=link-1", headers: {} };
    const response = handleLinkStatus(req, linkHandoff);
    expect(JSON.parse(response.body)).toEqual({ status: "pending" });
  });

  it("reports ready with the credential and display name on the first poll after the callback completes, then not-found on a second poll", () => {
    linkHandoff.markReady("link-1", { credential: "raw-credential-abc", displayName: "juicykaraage" });
    const req = { method: "GET", url: "/api/link-status?linkId=link-1", headers: {} };

    const first = handleLinkStatus(req, linkHandoff);
    expect(JSON.parse(first.body)).toEqual({ status: "ready", credential: "raw-credential-abc", displayName: "juicykaraage" });

    const second = handleLinkStatus(req, linkHandoff);
    expect(JSON.parse(second.body)).toEqual({ status: "not-found" });
  });
});

describe("handleRotateProducerCredential", () => {
  it("401s when no Authorization header is present", async () => {
    const req = { method: "POST", url: "/api/producer-credential/rotate", headers: {} };
    const response = await handleRotateProducerCredential(req, db);
    expect(response.status).toBe(401);
  });

  it("401s for a malformed (non-Bearer) Authorization header", async () => {
    const req = { method: "POST", url: "/api/producer-credential/rotate", headers: { authorization: "Basic abc123" } };
    const response = await handleRotateProducerCredential(req, db);
    expect(response.status).toBe(401);
  });

  it("401s for an invalid/unknown credential", async () => {
    const req = { method: "POST", url: "/api/producer-credential/rotate", headers: { authorization: "Bearer not-a-real-token" } };
    const response = await handleRotateProducerCredential(req, db);
    expect(response.status).toBe(401);
  });

  it("issues a new credential and invalidates the old one for a valid bearer credential", async () => {
    const oldToken = await issueProducerCredential(db, broadcasterId);
    const req = { method: "POST", url: "/api/producer-credential/rotate", headers: { authorization: `Bearer ${oldToken}` } };

    const response = await handleRotateProducerCredential(req, db);
    expect(response.status).toBe(200);
    const { credential: newToken } = JSON.parse(response.body) as { credential: string };

    expect(newToken).not.toBe(oldToken);
    expect(await validateProducerCredential(db, oldToken)).toBeNull();
    expect(await validateProducerCredential(db, newToken)).not.toBeNull();
  });
});

describe("handleProducerCredentialStatus", () => {
  it("401s when no Authorization header is present", async () => {
    const req = { method: "GET", url: "/api/producer-credential/status", headers: {} };
    const response = await handleProducerCredentialStatus(req, db);
    expect(response.status).toBe(401);
  });

  it("reports status 200 {status: \"valid\"} for a valid credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const req = { method: "GET", url: "/api/producer-credential/status", headers: { authorization: `Bearer ${token}` } };
    const response = await handleProducerCredentialStatus(req, db);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "valid" });
  });

  it("reports {status: \"invalid_or_malformed\"} for an unknown token, still as a 200", async () => {
    const req = { method: "GET", url: "/api/producer-credential/status", headers: { authorization: "Bearer not-a-real-token" } };
    const response = await handleProducerCredentialStatus(req, db);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "invalid_or_malformed" });
  });

  it("reports {status: \"revoked_or_replaced\"} for a revoked credential", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await revokeAllCredentialsForBroadcaster(db, broadcasterId);
    const req = { method: "GET", url: "/api/producer-credential/status", headers: { authorization: `Bearer ${token}` } };
    const response = await handleProducerCredentialStatus(req, db);
    expect(JSON.parse(response.body)).toEqual({ status: "revoked_or_replaced" });
  });

  it("reports {status: \"not_allowlisted\"} for a valid credential whose broadcaster was removed from the allowlist", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    await removeFromAllowlist(db, "141981764");
    const req = { method: "GET", url: "/api/producer-credential/status", headers: { authorization: `Bearer ${token}` } };
    const response = await handleProducerCredentialStatus(req, db);
    expect(JSON.parse(response.body)).toEqual({ status: "not_allowlisted" });
  });

  it("never includes the bearer token itself anywhere in the response body", async () => {
    const token = await issueProducerCredential(db, broadcasterId);
    const req = { method: "GET", url: "/api/producer-credential/status", headers: { authorization: `Bearer ${token}` } };
    const response = await handleProducerCredentialStatus(req, db);
    expect(response.body).not.toContain(token);
  });
});
