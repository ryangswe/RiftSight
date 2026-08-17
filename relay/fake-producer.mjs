// Scratch test helper (untracked — delete when done). Publishes fake but
// schema-valid OverlayState to a LOCAL relay so the YouTube viewer overlay
// has something to render without real Riftbound gameplay. Uses the
// unauthenticated bare-socket producer path (development mode only).
//
//   node fake-producer.mjs <sessionId> [port]
//
// sessionId must equal the session key the viewer resolves to:
//   - plain-`subscribe` build  -> sessionId = the YouTube channelId ("UC...")
//   - `youtube-subscribe` build -> sessionId = the broadcasterId you seeded
// port defaults to 8787.

import { WebSocket } from "ws";

const sessionId = process.argv[2];
const port = Number(process.argv[3]) || 8787;
if (!sessionId) {
  console.error("usage: node fake-producer.mjs <sessionId> [port]");
  process.exit(1);
}

// Six public cards laid across the middle of the frame. visibility:"public"
// is required to legally carry a cardId (schema refine, schema.ts:86).
const cards = Array.from({ length: 6 }, (_, i) => ({
  instanceId: `card_${i}`,
  cardId: `OGN-${String(100 + i).padStart(3, "0")}`,
  zone: "battlefield",
  owner: "self",
  visibility: "public",
  bounds: { x: 0.06 + i * 0.15, y: 0.42, width: 0.11, height: 0.17 },
  rotation: 0,
  localWidth: 0.11,
  localHeight: 0.17,
  landscape: false,
  fromDialog: false,
}));

const url = `ws://localhost:${port}/`;
const ws = new WebSocket(url);
let sequence = 0;

ws.on("open", () => {
  console.log(`[fake-producer] connected ${url}, publishing as session "${sessionId}"`);
  const tick = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "overlay-state",
        payload: {
          protocolVersion: 1,
          sessionId,
          sequence: ++sequence,
          capturedAt: Date.now(),
          sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
          cards,
        },
      })
    );
  };
  tick();
  setInterval(tick, 1000); // republish every 1s (well under the relay's STATE_TTL)
});

ws.on("error", (e) => console.error("[fake-producer] error:", e.message));
ws.on("close", () => console.log("[fake-producer] closed"));
