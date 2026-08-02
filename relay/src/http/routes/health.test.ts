import { describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { handleHealth, handleReady } from "./health.js";

describe("handleHealth", () => {
  it("always reports ok", () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });
});

describe("handleReady", () => {
  it("reports ready when the database responds", async () => {
    const db: DbClient = createDbClient(":memory:");
    const response = await handleReady({ db });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ready" });
    db.close();
  });

  it("reports not-ready (503) when the database is unreachable", async () => {
    const db: DbClient = createDbClient(":memory:");
    db.close(); // subsequent queries against a closed client fail
    const response = await handleReady({ db });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).status).toBe("not-ready");
  });
});
