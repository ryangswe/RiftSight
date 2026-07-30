# RiftSight

RiftSight is a browser extension and Twitch overlay for [RiftAtlas](https://riftatlas.com) (a fan-made Riftbound TCG web client) which allows viewers to hover over cards during a RiftAtlas to see their details in real-time.

## Packages

- `extension/` — MV3 Chromium extension. Content script detects cards on the RiftAtlas board (`src/content/card-detector.ts`) and, optionally, publishes sanitized state (`src/content/publisher.ts`); a background service worker (`src/background/background.ts`) owns the relay connection.
- `protocol/` — shared, DOM-free types/validation/privacy-serializer/publisher used by both the extension and the debug viewer. Also home to `history.ts` (the binary-search state lookup + rolling time-window buffer shared by delayed-live and recording playback) and `recording.ts` (the recording data model, import validation, and `OverlayRecorder`).
- `relay/` — minimal local WebSocket relay. In-memory only, no auth, one process, no history — it only ever holds the single latest state per session. Delayed-live and recordings are entirely a debug-viewer-side concern (see "Viewer modes" below).
- `debug-viewer/` — static HTML/TS page that renders hoverable hitboxes over an optional screenshot or video background, in one of three modes (live / delayed-live / recording-playback — see below).

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

6. **Add a screenshot (optional).** The stage works without one — it falls back to a plain CSS board background at a 16:9 aspect ratio so hitboxes always have something to render over. Two ways to add a real one: drop a full, uncropped screenshot of the RiftAtlas viewport at `debug-viewer/public/fixtures/riftatlas-game.png` (loaded automatically on page load if present), or use the **Screenshot** file picker in the viewer's header to load one from disk on the fly (kept local via an object URL — never uploaded or persisted; **Clear** returns to the fallback board). Either way, normalized coordinates only align correctly if the screenshot depicts the same full viewport (not cropped) and preserves its aspect ratio — the exact pixel dimensions don't need to match the extension's source viewport. A local video works the same way (own file picker, own Clear button) — see "Viewer modes" below. Video and screenshot are mutually exclusive backgrounds; whichever you loaded most recently is what's shown, and either one's Clear button returns to the fallback board (not to the other).

## Viewer modes

The mode selector in the debug viewer's second header row switches between three ways of deciding which `OverlayState` to render. Every state the viewer receives is buffered locally regardless of the active mode (a rolling ~60s window, keyed by `capturedAt`), so switching modes never requires waiting for history to reaccumulate.

- **Live** — renders whatever state just arrived. This is the original, unchanged behavior from the previous milestone.
- **Delayed-live** — renders what the board looked like `delay` ms ago, proving an overlay can compensate for stream latency. Set the delay (ms input or the 0/2/5/10s presets — takes effect immediately, no reload) and the **Status** readout shows **waiting for history** until at least `delay` ms of real collection time has actually elapsed since the page loaded (not just "is there some old sample lying around" — a reconnect can hand you the relay's one retained state from an arbitrarily long time ago, which must not be mistaken for continuous coverage), then **synchronized**.
- **Recording-playback** — replays an imported `OverlayRecording` in sync with a locally loaded video, using `targetOffsetMs = video.currentTime * 1000 + syncOffsetMs`. **Sign convention:** positive `syncOffsetMs` advances the overlay timeline ahead of the video; negative delays it (labeled `+ahead / -behind` next to the input). Adjust it with the ms input or the ±10/100/500ms step buttons. Status reads **before first recorded state** (an empty/waiting state — nothing renders) while the video is earlier than the recording's first state, **synchronized** while within range, or **past end of recording (holding last state)** once the video runs past the last recorded state (deliberately not cleared — the last known state is more useful than a blank overlay for a debug tool). Play/pause/seek/rate all work through the video element's native controls; pausing simply stops `timeupdate` from firing, so the last-rendered overlay just stays put with no special-case code needed.

### Recording a session

The **Recording** bar: **Start**/**Stop** capture every live state that arrives while active (skipping states that are semantically identical to the last recorded one, the same dedup the live publisher already does — so recording a completely idle board doesn't grow the file). **Export JSON** downloads the current recording as a local file (nothing is uploaded anywhere); **Import** loads a previously exported (or hand-written) recording from disk, validating it and normalizing out-of-order `offsetMs` values rather than rejecting them outright — a structurally invalid file (bad JSON, wrong `recordingVersion`, malformed states) is rejected with a specific error instead. **Clear** discards the current in-memory recording. All of this is in-browser only; there's no server-side recording storage anywhere in this repo.

### Manual test: record RiftAtlas + verify synchronized playback

1. Start the local stack (relay, debug viewer, extension loaded and pointed at a RiftAtlas tab).
2. Open RiftAtlas and the debug viewer side by side, matching session ids.
3. In the debug viewer's Recording bar, click **Start**.
4. Start a local screen recording of the RiftAtlas tab (any screen recorder).
5. Perform a few obvious, distinguishable actions in RiftAtlas: move a card, rotate it, turn it face down, move it to another zone.
6. Stop both recordings (the debug viewer's **Stop**, and your screen recorder).
7. Click **Export JSON** in the debug viewer and save the file.
8. Switch the debug viewer to **Recording playback** mode, load your screen recording via the **Video** file picker, and **Import** the JSON you just exported.
9. Adjust **Sync offset** (input or the ±10/100/500ms buttons) while watching the video-time / state-offset / diff readout, until the hitboxes visibly line up with the actions in the video.
10. Verify the hitboxes track each of the four actions from step 5 as the video plays.
11. Seek the video backward and forward — the overlay should update immediately (via the `seeked` event, not just `timeupdate`).
12. Change the video's playback rate — synchronization should keep working (the target-offset calculation only depends on `currentTime`, never on rate).
13. Confirm the overlay stays synchronized through all of the above without needing to touch the sync offset again.

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
- **`capturedAt` is single-machine wall-clock time, not synchronized:** it's `Date.now()` on whichever machine ran the extension, trusted as-is by the relay, delayed-live's buffer, and recording. That's fine here because every component in this prototype runs on the one machine — a real multi-machine deployment would need a synchronized or server-authoritative clock instead of raw `Date.now()` deltas. See the doc comment on `capturedAt` in `protocol/src/schema.ts`.
- **Delayed-live's buffer is per-tab and in-memory, not the relay:** reloading the debug viewer resets its collected history (and briefly re-enters "waiting for history"), and two viewer tabs on the same session each keep their own independent buffer. The relay itself still only ever holds one latest state — it was deliberately not extended for this milestone (see `protocol/src/history.ts`'s header comment for why).
- **Recording/video sync is manual, not automatic:** there's no attempt to detect or correct drift between the recorded state timeline and the video — you set `syncOffsetMs` by eye and it stays fixed. Frame-perfect or automatic audio/visual synchronization is out of scope for this milestone.
- **Video and screenshot backgrounds are mutually exclusive:** loading one deactivates the other (whichever was loaded most recently wins); each medium's own Clear button always returns to the CSS fallback board, never to "whatever was showing before."
