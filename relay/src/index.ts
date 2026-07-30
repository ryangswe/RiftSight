import { createRelayServer } from "./server.js";

const port = Number(process.env.RELAY_PORT) || 8787;

createRelayServer(port, {
  twitchExtensionClientId: process.env.TWITCH_EXTENSION_CLIENT_ID,
  twitchExtensionSecret: process.env.TWITCH_EXTENSION_SECRET,
  allowLocalDebug: process.env.ALLOW_LOCAL_DEBUG !== "false",
}).catch((err: unknown) => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
