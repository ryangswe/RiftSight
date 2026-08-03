import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "./client.js";
import { runMigrations, type Migration } from "./migrate.js";

let db: DbClient;

beforeEach(() => {
  db = createDbClient(":memory:");
});

afterEach(() => {
  db.close();
});

describe("runMigrations", () => {
  it("applies a pending migration and reports it as applied", async () => {
    const migrations: Migration[] = [{ version: 1, name: "init", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY);" }];
    const result = await runMigrations(db, migrations);
    expect(result.applied).toEqual(["init"]);

    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='widgets'");
    expect(tables.rows.length).toBe(1);
  });

  it("does not re-apply an already-applied migration", async () => {
    const migrations: Migration[] = [{ version: 1, name: "init", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY);" }];
    await runMigrations(db, migrations);
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
  });

  it("applies multiple pending migrations in version order", async () => {
    const migrations: Migration[] = [
      { version: 2, name: "second", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" },
      { version: 1, name: "first", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" },
    ];
    const result = await runMigrations(db, migrations);
    expect(result.applied).toEqual(["first", "second"]);
  });

  it("applies a migration with multiple statements atomically", async () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "init",
        sql: "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY);",
      },
    ];
    await runMigrations(db, migrations);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.rows.map((row) => row["name"]);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("strips leading SQL comment lines before a statement (regression: broke against the file-backed driver)", async () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: "init",
        sql: [
          "-- A leading doc comment, like every real migration file has.",
          "-- Spanning multiple lines.",
          "CREATE TABLE widgets (id INTEGER PRIMARY KEY);",
          "",
          "-- Another comment before the second statement.",
          "CREATE TABLE gadgets (id INTEGER PRIMARY KEY);",
        ].join("\n"),
      },
    ];
    const result = await runMigrations(db, migrations);
    expect(result.applied).toEqual(["init"]);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.rows.map((row) => row["name"]);
    expect(names).toContain("widgets");
    expect(names).toContain("gadgets");
  });

  it("does not mark a failing migration as applied", async () => {
    const migrations: Migration[] = [{ version: 1, name: "broken", sql: "THIS IS NOT VALID SQL;" }];
    await expect(runMigrations(db, migrations)).rejects.toThrow();

    const applied = await db.execute("SELECT * FROM schema_migrations WHERE version = 1");
    expect(applied.rows.length).toBe(0);
  });

  it("only applies migrations not already recorded, leaving prior data intact", async () => {
    await runMigrations(db, [
      { version: 1, name: "init", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);" },
    ]);
    await db.execute({ sql: "INSERT INTO widgets (id, label) VALUES (?, ?)", args: [1, "keep me"] });

    await runMigrations(db, [
      { version: 1, name: "init", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);" },
      { version: 2, name: "add_gadgets", sql: "CREATE TABLE gadgets (id INTEGER PRIMARY KEY);" },
    ]);

    const widgets = await db.execute("SELECT * FROM widgets");
    expect(widgets.rows.length).toBe(1);
    expect(widgets.rows[0]?.["label"]).toBe("keep me");
  });
});
