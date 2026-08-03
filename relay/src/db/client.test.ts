import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";

let dir: string | undefined;
let db: DbClient | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("createDbClient", () => {
  it("creates a missing parent directory for a file: URL rather than failing to open", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "riftsight-client-"));
    const nestedDir = path.join(dir, "nested", "data");
    expect(existsSync(nestedDir)).toBe(false);

    db = createDbClient(`file:${path.join(nestedDir, "test.db")}`);
    await db.execute("SELECT 1"); // would throw ConnectionFailed/SQLITE_CANTOPEN before the fix

    expect(existsSync(nestedDir)).toBe(true);
  });

  it("does not attempt directory creation for :memory:", () => {
    db = createDbClient(":memory:");
    expect(db).toBeDefined();
  });
});
