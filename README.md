# RiftSight

An exploratory prototype for detecting cards rendered inside [RiftAtlas](https://riftatlas.com) (a fan-made Riftbound TCG client) and publishing their state to a separate debug viewer, as groundwork for an eventual Twitch overlay. Twitch integration, screen capture, and OCR/computer vision are explicitly out of scope for now — see the plan notes in-repo for the full rationale.

## Packages

- `extension/` — MV3 Chromium extension. Content script detects cards on the RiftAtlas board (`src/content/card-detector.ts`) and, optionally, publishes sanitized state (`src/content/publisher.ts`); a background service worker (`src/background/background.ts`) owns the relay connection.
- `protocol/` — shared, DOM-free types/validation/privacy-serializer/publisher used by both the extension and the debug viewer.
- `relay/` — minimal local WebSocket relay. In-memory only, no auth, one process.
- `debug-viewer/` — static HTML/TS page that renders hoverable hitboxes over a screenshot fixture.

## Setup

```bash
npm install
```

## Local workflow

1. **Build and load the extension.**
   ```bash
   npm run build -w extension
   ```
   Open `chrome://extensions`, enable Developer mode, **Load unpacked**, and select the `extension/` folder. If you change extension source, either re-run the build or use `npm run watch -w extension` and reload the extension in Chrome afterward.

2. **Start the relay.**
   ```bash
   npm run start -w relay
   ```
   Listens on `ws://localhost:8787` by default (override with `RELAY_PORT`).

3. **Start the debug viewer.**
   ```bash
   npm run dev -w debug-viewer
   ```
   Serves `debug-viewer/` at `http://localhost:8788`. (Run this in your own interactive terminal — esbuild's `--serve` mode watches stdin and exits if it's closed, which only matters for non-interactive/background shells.)

   Or, to run all three together:
   ```bash
   npm run dev
   ```

4. **Begin a scan.** In a RiftAtlas tab (a solo room is easiest — no opponent needed), open the floating "RiftSight Inspector" panel the content script injects. Under **Live Publishing**, confirm the session id (defaults to `local-debug`) and click **Start publishing**. The panel polls the background worker every 2s and shows the relay connection state and how many snapshots have been sent.

5. **Select a matching session.** The debug viewer reads its session from the `?session=` query param (or the input field, Enter to switch) — it must match what you set in the extension panel. Both default to `local-debug`, so if you haven't changed either, no action is needed.

6. **Add a screenshot (optional).** The stage works without one — it falls back to a plain CSS board background at a 16:9 aspect ratio so hitboxes always have something to render over. Two ways to add a real one: drop a full, uncropped screenshot of the RiftAtlas viewport at `debug-viewer/public/fixtures/riftatlas-game.png` (loaded automatically on page load if present), or use the **Screenshot** file picker in the viewer's header to load one from disk on the fly (kept local via an object URL — never uploaded or persisted; **Clear** returns to the fallback board). Either way, normalized coordinates only align correctly if the screenshot depicts the same full viewport (not cropped) and preserves its aspect ratio — the exact pixel dimensions don't need to match the extension's source viewport.

## Commands

```bash
npm run typecheck   # all packages
npm test             # all packages (vitest)
npm run build        # extension + debug-viewer (protocol/relay have no build step — they run from source)
npm run dev           # extension watch + relay + debug-viewer, together
```

## Known limitations

- **MV3 service worker lifecycle:** the background worker can be suspended by Chrome after ~30s idle, dropping the relay connection. Reconnect-on-wake (the worker re-initializes and reconnects when Chrome wakes it) handles this adequately for local use; there's no keepalive workaround.
- **Geometry is axis-aligned only:** `bounds` is a card's post-rotation bounding box, not its true rotated silhouette. The viewer applies `rotation` as a CSS transform on top of that box, which is a visual approximation, not exact geometry.
- **Single producer per session, last-write-wins:** if two extension instances publish to the same session id, there's no arbitration — whichever sent most recently is treated as current.
- **No auth, no persistence, no database:** the relay keeps everything in memory for one process and accepts any producer/viewer. This is a local prototype, not something to expose beyond `localhost`.
- **Old bundled npm (8.1.2, from Node 16) has a workspace-linking bug** that can surface as a spurious registry 404 for `@riftsight/*` packages after adding/changing a dependency. If `npm install` fails that way, run `rm -rf node_modules package-lock.json && npm install` for a clean re-link.
