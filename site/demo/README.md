# Interactive "See it in action" demo — fixture

This folder holds the data for the interactive demo on the landing page. The
demo runs the **real** RiftSight overlay code (`@riftsight/overlay-core`'s
`CardHoverOverlay`, the same controller the Twitch viewer uses) against a
**static** board state — it never connects to the relay, Twitch, or any
WebSocket/API.

## Files

- `demo-state.json` — a captured RiftSight `OverlayState` payload (the exact
  shape the extension publishes; normalized `[0,1]` card coordinates).
- `demo-board.webp` — the matching Rift Atlas screenshot shown as the "stream".
  Its aspect ratio must match the fixture's `sourceViewport` (card coordinates
  are fractions of it); resolution only affects sharpness, not alignment.

Card art is loaded directly from each public card's `imageUrl` (a RiftAtlas
CDN URL in the payload) — there is no bundled card art.

The demo is wired through `config.js` → `interactiveDemo` (`state`, `board`,
optional `sourceRegion`, optional `tooltipScale`).

## Swapping in a real board

1. **Build the board in Rift Atlas.** Create a game state that shows off the
   behaviors you want (visible cards for both players, a rotated card, a
   battlefield/landscape card, some overlap, and at least one facedown/hidden
   card — which will correctly stay non-interactive).

2. **Capture the exact published state.** Run the RiftSight browser extension
   and start publishing from that board. Open the **debug-viewer**
   (`npm run dev -w debug-viewer`), connect to your session, then click
   **"⬇ Board state (demo fixture)"** in the Recording bar. Save the download
   as `demo-state.json` here (overwrite this file). That JSON is the real
   payload — no manual editing needed. Only cards the overlay would actually
   expose carry identity/image data; hidden cards never do.

3. **Capture the matching screenshot.** Take a screenshot of the Rift Atlas
   game view **at that same moment**, cropped to exactly the region the card
   coordinates are relative to (the game frame the extension observes). Save it
   here (e.g. `demo-board.webp`) and point `interactiveDemo.board` in
   `config.js` at it. Prefer WebP and keep it reasonably sized.

4. **Verify alignment.** Run `npm run build -w site && npm run dev -w site`,
   open `http://localhost:4321/?demoDebug=1`, and scroll to "See it in action".
   The `?demoDebug=1` flag draws the hitbox outlines over the board — every
   outline should sit exactly on its card (rotated cards included). If they're
   uniformly offset/scaled, the screenshot crop doesn't match the coordinate
   region: either re-crop it to the game frame, or set
   `interactiveDemo.sourceRegion` in `config.js` to the rectangle (normalized
   `{x,y,width,height}`) the board occupies within your screenshot.

5. Remove `?demoDebug=1` and confirm hover (desktop), tap (mobile), and Tab
   focus (keyboard) all show the right card previews.

## Notes

- Card art loads directly from whatever `imageUrl` each public card carries
  (RiftAtlas CDN for a real capture) — there is no bundled card database.
- If a card image fails to load, that card shows a small text fallback rather
  than a broken image; the rest of the demo keeps working.
- With JavaScript disabled, the board screenshot still renders as a static
  image (no previews) — graceful degradation.
