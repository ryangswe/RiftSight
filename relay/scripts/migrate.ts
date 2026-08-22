// Applies any pending SQL migrations from src/db/migrations/ to the
// database at RIFTSIGHT_DB_PATH. Run once at deploy time before starting
// the relay (npm run migrate -w relay), and any time a new migration file
// is added.

import { createDbClient } from "../src/db/client.js";
import { loadMigrations, runMigrations } from "../src/db/migrate.js";
import { validateEnv } from "../src/env.js";

const result = validateEnv(process.env);
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[migrate] ${error}`);
  }
  process.exit(1);
}

const db = createDbClient(result.config.dbUrl, result.config.tursoAuthToken);
const migrations = await loadMigrations();
const { applied } = await runMigrations(db, migrations);

if (applied.length === 0) {
  console.log("[migrate] up to date, nothing to apply");
} else {
  console.log(`[migrate] applied: ${applied.join(", ")}`);
}

db.close();
