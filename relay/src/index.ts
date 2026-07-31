import { createRelayServer } from "./server.js";

const port = Number(process.env.RELAY_PORT) || 8787;
const twitchExtensionSecret = process.env.TWITCH_EXTENSION_SECRET;
const allowLocalDebug = process.env.ALLOW_LOCAL_DEBUG !== "false";

if (!twitchExtensionSecret) {
  console.warn(
    "[relay] TWITCH_EXTENSION_SECRET is not set — every twitch-subscribe will be rejected until it is configured. See .env.example."
  );
}

createRelayServer(port, {
  twitchExtensionClientId: process.env.TWITCH_EXTENSION_CLIENT_ID,
  twitchExtensionSecret,
  allowLocalDebug,
}).catch((err: unknown) => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
