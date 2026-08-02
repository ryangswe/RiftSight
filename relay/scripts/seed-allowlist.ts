// Closed-beta allowlist admin workflow — a CLI rather than a protected HTTP
// endpoint, since a 3-10 streamer beta doesn't need a separate admin-auth
// design. Usage:
//   npm run seed-allowlist -w relay -- add <twitchUserId> [note...]
//   npm run seed-allowlist -w relay -- remove <twitchUserId>
//   npm run seed-allowlist -w relay -- list

import { createDbClient } from "../src/db/client.js";
import { addToAllowlist, listAllowlist, removeFromAllowlist } from "../src/db/allowlist.js";
import { validateEnv } from "../src/env.js";

function usage(): never {
  console.error("Usage: seed-allowlist add <twitchUserId> [note...] | remove <twitchUserId> | list");
  process.exit(1);
}

const [, , command, twitchUserId, ...noteParts] = process.argv;

const result = validateEnv(process.env);
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[seed-allowlist] ${error}`);
  }
  process.exit(1);
}
const db = createDbClient(result.config.dbUrl);

switch (command) {
  case "add": {
    if (!twitchUserId) usage();
    await addToAllowlist(db, twitchUserId, noteParts.join(" ") || undefined);
    console.log(`[seed-allowlist] added "${twitchUserId}"`);
    break;
  }
  case "remove": {
    if (!twitchUserId) usage();
    await removeFromAllowlist(db, twitchUserId);
    console.log(`[seed-allowlist] removed "${twitchUserId}" — their producer credential is revoked on their next connection attempt`);
    break;
  }
  case "list": {
    const entries = await listAllowlist(db);
    if (entries.length === 0) {
      console.log("[seed-allowlist] allowlist is empty");
    } else {
      for (const entry of entries) {
        console.log(`${entry.twitchUserId}\tadded ${entry.addedAt}${entry.note ? `\t${entry.note}` : ""}`);
      }
    }
    break;
  }
  default:
    usage();
}

db.close();
