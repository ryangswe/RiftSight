// Closed-beta allowlist + producer-credential admin workflow — a CLI
// rather than a protected HTTP endpoint, since a 3-10 streamer beta
// doesn't need a separate admin-auth design. Usage:
//   npm run seed-allowlist -w relay -- add <twitchUserId-or-username> [note...]
//   npm run seed-allowlist -w relay -- remove <twitchUserId-or-username>
//   npm run seed-allowlist -w relay -- list
//   npm run seed-allowlist -w relay -- credential-status <twitchUserId-or-username>
//
// Every ID-taking command above also accepts a plain Twitch username, not
// just a numeric ID — resolved via Twitch's own Helix API (the same
// TWITCH_API_CLIENT_ID/SECRET already configured for OAuth linking, no new
// credentials needed). A streamer virtually never knows their own numeric
// Twitch ID offhand — nothing in Twitch's own UI surfaces it — but they
// always know their username, so this removes that friction from
// onboarding entirely. Detection is a simple heuristic: a purely-numeric
// argument is trusted as an ID already (and used as-is, skipping the API
// round trip); anything else is resolved as a username.

import { createDbClient } from "../src/db/client.js";
import { addToAllowlist, listAllowlist, removeFromAllowlist } from "../src/db/allowlist.js";
import { getBroadcasterByTwitchUserId } from "../src/db/broadcasters.js";
import { listCredentialLifecycleForBroadcaster } from "../src/db/producer-credentials.js";
import { resolveTwitchUserIdByLogin } from "../src/auth/twitch-oauth.js";
import { validateEnv } from "../src/env.js";

function usage(): never {
  console.error(
    "Usage: seed-allowlist add <twitchUserId-or-username> [note...] | remove <twitchUserId-or-username> | list | credential-status <twitchUserId-or-username>"
  );
  process.exit(1);
}

const [, , command, idOrLogin, ...noteParts] = process.argv;

const result = validateEnv(process.env);
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[seed-allowlist] ${error}`);
  }
  process.exit(1);
}
// Captured directly (rather than reading result.config from inside
// resolveUserId below) because TypeScript doesn't carry the `result.ok`
// narrowing above across a closure boundary into a function declared
// later — this local is exactly as narrowed as `db` above already relies
// on being.
const config = result.config;
const db = createDbClient(config.dbUrl);

/**
 * Resolves whatever was typed on the command line to a numeric Twitch user
 * ID — already-numeric input is trusted as-is; anything else is looked up
 * as a username. Exits the process on failure with a clear reason rather
 * than returning an error every call site would have to remember to
 * check — every command below needs a real ID before it can do anything
 * useful.
 */
async function resolveUserId(rawIdOrLogin: string): Promise<string> {
  if (/^\d+$/.test(rawIdOrLogin)) return rawIdOrLogin;

  const login = rawIdOrLogin.replace(/^@/, "");
  if (!config.twitchApiClientId || !config.twitchApiClientSecret) {
    console.error(
      `[seed-allowlist] "${rawIdOrLogin}" doesn't look like a numeric Twitch ID, and TWITCH_API_CLIENT_ID/SECRET aren't configured to resolve a username — pass the numeric ID directly instead.`
    );
    process.exit(1);
  }

  const resolved = await resolveTwitchUserIdByLogin({ clientId: config.twitchApiClientId, clientSecret: config.twitchApiClientSecret }, login);
  if (resolved.status === "not-found") {
    console.error(`[seed-allowlist] no Twitch account found for username "${login}"`);
    process.exit(1);
  }
  if (resolved.status === "error") {
    console.error(`[seed-allowlist] failed to resolve username "${login}": ${resolved.message}`);
    process.exit(1);
  }
  console.log(`[seed-allowlist] resolved username "${login}" to Twitch user ID ${resolved.userId}`);
  return resolved.userId;
}

switch (command) {
  case "add": {
    if (!idOrLogin) usage();
    const twitchUserId = await resolveUserId(idOrLogin);
    await addToAllowlist(db, twitchUserId, noteParts.join(" ") || undefined);
    console.log(`[seed-allowlist] added "${twitchUserId}"`);
    break;
  }
  case "remove": {
    if (!idOrLogin) usage();
    const twitchUserId = await resolveUserId(idOrLogin);
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
  case "credential-status": {
    if (!idOrLogin) usage();
    const twitchUserId = await resolveUserId(idOrLogin);
    const broadcaster = await getBroadcasterByTwitchUserId(db, twitchUserId);
    if (!broadcaster) {
      console.log(`[seed-allowlist] no broadcaster record for "${twitchUserId}" — they've never linked their Twitch account`);
      break;
    }
    const lifecycle = await listCredentialLifecycleForBroadcaster(db, twitchUserId);
    if (lifecycle.length === 0) {
      console.log(`[seed-allowlist] "${twitchUserId}" has never had a producer credential issued`);
    } else {
      for (const entry of lifecycle) {
        console.log(
          [
            entry.active ? "active " : "revoked",
            `issued ${entry.issuedAt}`,
            `last used: ${entry.lastUsedAt ?? "never"}`,
            entry.rotatedAt ? `rotated: ${entry.rotatedAt}` : undefined,
            entry.revokedAt ? `revoked: ${entry.revokedAt}` : undefined,
          ]
            .filter(Boolean)
            .join("\t")
        );
      }
    }
    break;
  }
  default:
    usage();
}

db.close();
