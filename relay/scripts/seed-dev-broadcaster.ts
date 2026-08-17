// Local-testing helper: creates (or reuses) a broadcaster with a linked +
// allowlisted YouTube channel against the LOCAL dev database and prints a
// producer credential — everything the real Google OAuth flow would do,
// minus Google, so the full authenticated pipeline (credentialed
// /ws/producer publish -> internal-session keying -> youtube-subscribe
// resolution) is testable end to end on a dev machine. Never point this at
// a production database; it exists for the workflow documented in
// docs/youtube-release-notes.md's testing section.
//
// Usage:
//   npm run seed-dev-broadcaster -w relay -- <UC-channel-id> [display name...]

import { createDbClient } from "../src/db/client.js";
import { loadMigrations, runMigrations } from "../src/db/migrate.js";
import { addToYouTubeAllowlist } from "../src/db/allowlist.js";
import { linkOrCreateBroadcasterWithIdentity } from "../src/db/identities.js";
import { issueProducerCredential } from "../src/db/producer-credentials.js";
import { validateEnv } from "../src/env.js";

const [, , channelId, ...nameParts] = process.argv;

if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
  console.error("Usage: seed-dev-broadcaster <UC-channel-id> [display name...]  (canonical UC... id required)");
  process.exit(1);
}

const result = validateEnv(process.env);
if (!result.ok) {
  for (const error of result.errors) console.error(`[seed-dev] ${error}`);
  process.exit(1);
}
if (result.config.mode === "closed-beta") {
  console.error("[seed-dev] refusing to run against a closed-beta configuration — this is a local dev tool.");
  process.exit(1);
}

const db = createDbClient(result.config.dbUrl);
await runMigrations(db, await loadMigrations());

const displayName = nameParts.join(" ") || channelId;
await addToYouTubeAllowlist(db, channelId, "seed-dev-broadcaster");
const { broadcasterId } = await linkOrCreateBroadcasterWithIdentity(db, "youtube", channelId, displayName);
const credential = await issueProducerCredential(db, broadcasterId);

console.log(`[seed-dev] broadcaster #${broadcasterId} linked to youtube channel ${channelId} ("${displayName}")`);
console.log(`[seed-dev] producer credential (paste into the extension service worker console — see docs):`);
console.log(credential);
console.log(`[seed-dev] paste-ready snippet:`);
console.log(
  `chrome.storage.local.set({ "riftsight.producerCredential": "${credential}", "riftsight.linkState": { status: "connected", displayName: "${displayName.replace(/"/g, "")}", platform: "youtube" } })`
);

db.close();
