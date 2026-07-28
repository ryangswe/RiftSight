import { createRelayServer } from "./server.js";

const port = Number(process.env.RELAY_PORT) || 8787;

createRelayServer(port).catch((err: unknown) => {
  console.error("[relay] failed to start:", err);
  process.exit(1);
});
