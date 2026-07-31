# RiftSight

RiftSight is a browser extension and Twitch overlay for [RiftAtlas](https://riftatlas.com) (a fan-made Riftbound TCG web client) which allows viewers to hover over cards during a RiftAtlas to see their details in real-time.

## Packages

- `extension/` — MV3 Chromium extension. Content script detects cards on the RiftAtlas board (`src/content/card-detector.ts`) and, optionally, publishes sanitized state (`src/content/publisher.ts`); a background service worker (`src/background/background.ts`) owns the relay connection.
- `protocol/` — shared, DOM-free types/validation/privacy-serializer/publisher used by both the extension and the debug viewer. Also home to `history.ts` (the binary-search state lookup + rolling time-window buffer shared by delayed-live and recording playback) and `recording.ts` (the recording data model, import validation, and `OverlayRecorder`).
- `relay/` — minimal local WebSocket relay. In-memory only, no auth, one process, no history — it only ever holds the single latest state per session. Delayed-live and recordings are entirely a debug-viewer-side concern (see "Viewer modes" below).
- `overlay-core/` — shared, DOM-free (no DOM lib in its `tsconfig.json`) card-hitbox/tooltip rendering geometry (`render.ts`, `tooltip.ts`), the delayed-live/recording-playback state-selection calculators (`mode.ts`), the broadcaster-calibrated source-region mapping (`source-region.ts` — see "Source-region calibration" below), and the platform-adapter seam (`platform.ts`'s `ViewerPlatformContext`/`OverlayStateSource`) shared between `debug-viewer` and `twitch-extension` without either depending on the other.
- `debug-viewer/` — static HTML/TS page that renders hoverable hitboxes over an optional screenshot or video background, in one of three modes (live / delayed-live / recording-playback — see below).
- `twitch-extension/` — the real Twitch video-overlay extension frontend, built for Twitch's Local Test workflow (see "Twitch overlay" below). Two entry points: `src/viewer/main.ts` (the video overlay itself) and `src/config/main.ts` (a minimal broadcaster configuration page). Both reuse `overlay-core`'s rendering/tooltip/delay logic — no card-rendering code is duplicated from `debug-viewer`.

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
   Listens on `ws://localhost:8787` by default (override with `RELAY_PORT`). Three more env vars matter once a Twitch overlay is in the picture (see "Twitch overlay" below for the full Local Test walkthrough):
   - `TWITCH_EXTENSION_CLIENT_ID` — your extension's client ID (currently used for logging only).
   - `TWITCH_EXTENSION_SECRET` — the extension's base64-encoded secret from the Twitch Developer Console. Required before the relay will accept any `twitch-subscribe`; without it, that path is refused outright rather than trusting an unverifiable token. Never put this in source control.
   - `ALLOW_LOCAL_DEBUG` — set to `false` to disable the plain, unauthenticated `subscribe` path (used by the debug viewer and local-only testing) entirely. Defaults to enabled.

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

## Twitch overlay (Local Test)

`twitch-extension/` is a Twitch video-overlay extension built for Twitch's **Local Test** workflow only — no public submission, no released hosting, no full streamer OAuth account linking. It's the first real Twitch-hosted frontend on top of the same relay/protocol everything else in this repo already uses.

```
RiftSight browser extension (streamer only)
  → relay (unchanged protocol, now with an authenticated subscribe path too)
    → twitch-extension/src/viewer (Twitch-hosted iframe)
      → hoverable card regions over the Twitch channel's video
```

A viewer never installs anything — only the streamer runs the RiftSight browser extension. Twitch loads the video-overlay extension automatically for anyone watching a channel where it's been activated.

### Architecture at a glance

- **Reused directly, unchanged:** `protocol/` (types, schema, `TimeWindowBuffer`/`findStateAtOrBefore`) and `overlay-core/` (`computeHitboxStyle`, `tooltipContentFor`, `delayedLiveTarget`/`isWaitingForHistory`, `mapBoundsToSourceRegion`). The debug-viewer's own screenshot/video-background machinery and its 3-way live/delayed-live/recording-playback mode selector are **not** reused — Twitch supplies the video itself, and there's no recording-playback mode here.
- **Twitch-specific, lives only in `twitch-extension/`:** the Extension Helper integration (`onAuthorized`, token refresh, `src/twitch-ext.d.ts`), the `TwitchOverlayStateSource`/`MockOverlayStateSource` implementations of `overlay-core`'s `OverlayStateSource`, the broadcaster config page, and all iframe/CSP-facing HTML.
- **`ViewerPlatformContext` / `OverlayStateSource`** (`overlay-core/src/platform.ts`) is the seam: the shared rendering code only ever asks for a stream of `OverlayState`, never for `window.Twitch` directly — so `debug-viewer` keeps working exactly as before, untouched by any of this.

### Backend authentication

The relay now accepts two kinds of viewer subscription:

- `{ type: "subscribe", sessionId }` — the original, unauthenticated path (`local-debug`, the debug viewer). Gate it off entirely with `ALLOW_LOCAL_DEBUG=false` if you want a posture closer to production.
- `{ type: "twitch-subscribe", channelId, token }` — verifies `token` as a real Twitch Extension JWT (HS256, against the base64-decoded `TWITCH_EXTENSION_SECRET`) and only admits the viewer if the JWT's own `channel_id` claim matches the requested `channelId` — the browser-supplied `channelId` is never trusted on its own. See `relay/src/twitch-auth.ts` and `relay/src/server.ts`.

The RiftSight browser extension's publishing side needs no changes: `sessionId` was already an arbitrary string end-to-end, so a Twitch channel ID is just another value for that same field (see the extension panel's "Session ID (or Twitch test channel ID)" label). **Never commit a personal channel ID to source control** — type it in locally each session.

### Source-region calibration

RiftSight publishes card bounds normalized relative to the **RiftAtlas viewport**, not the final stream canvas — that never changes, at the producer, protocol, or recording layers. If RiftAtlas doesn't fill the entire stream (a side panel, letterboxing, a centered capture with borders), the Twitch overlay needs a second transform: a broadcaster-calibrated `SourceRegion` (`overlay-core/src/source-region.ts`) describing exactly where RiftAtlas sits within the stream canvas, normalized 0–1. `mapBoundsToSourceRegion(cardBounds, sourceRegion)` — pure, DOM-free, unit-tested — applies `mappedX = region.x + cardBounds.x * region.width` (and the equivalent for y/width/height) in `viewer/main.ts`'s `renderHitboxes()`, right before computing CSS position; nothing else in the pipeline (state selection, delay, recording) is aware this transform exists.

**This is direct rectangular mapping only.** The broadcaster must select the exact final rectangle RiftAtlas is displayed in — there's no automatic contain/cover/crop-edge/letterbox/perspective correction, and no OBS integration or computer-vision detection. If the calibrated rectangle doesn't match reality, hitboxes will be uniformly offset/scaled wrong rather than corrected.

**Calibrating it:** open the broadcaster configuration page (`config.html`, or `config-mock.html` for local testing) — a "Source-region calibration" section provides:
- Numeric **x / y / width / height** inputs (always available and authoritative — the source of truth even if you never touch the visual preview). An invalid value (e.g. one that would push the region outside the frame) reverts to the last valid one rather than saving something broken.
- A 16:9 **visual preview** with a draggable region rectangle (drag the body to move, the corner handle to resize) and a live card-hitbox preview inside it — sourced from the channel's actual latest live state when available, falling back to example fixture cards otherwise. A hidden card in the preview only ever shows as "Hidden card", the same privacy guarantee as the real overlay.
- **Presets** (Full frame / Left half / Right half / Centered) and a **Reset to full frame** button.

Saving applies to the config's `sourceRegion` field alongside `overlayEnabled`/`delayMs`/`debugOutlines`/`sourceAspectRatio` — same persistence path (`configuration.set`/`configuration.broadcaster`), same live-update path (`configuration.onChanged`, no viewer reload needed), and the same backward-compatible default: a config saved before `sourceRegion` existed (or a corrupted one) parses to full frame, so every existing channel keeps behaving exactly as before this milestone.

The aspect-ratio diagnostic (`checkAspectRatioMismatch`, debug-mode only) now compares RiftAtlas's own source aspect ratio against **the calibrated region's own rendered aspect ratio** — `(stage width × region.width) / (stage height × region.height)` — rather than the full stage's aspect ratio, since the region may only cover part of the canvas.

### Mock mode (develop without Twitch)

Because iterating entirely inside Twitch's Local Test loop is slow, `twitch-extension/index.html` is a local mock harness that runs the *exact same* `src/viewer/main.ts` bundle Twitch would load, minus `window.Twitch` — it sets `window.__RIFTSIGHT_MOCK__ = true` before the script runs, which switches to `MockOverlayStateSource` (plain, unauthenticated relay subscribe, channel id typed into a text field) instead of `TwitchOverlayStateSource`. It also has its own delay controls, debug-outline toggle, and optional screenshot/video background for alignment testing (never present in the real Twitch-hosted page). `config-mock.html` is the same idea for the broadcaster config page — it saves to `localStorage` instead of Twitch's configuration service.

```bash
npm run dev -w twitch-extension
```
Serves `twitch-extension/` at `http://localhost:8789` — open `index.html` for the overlay mock harness, `config-mock.html` for the config page mock harness, and `viewer.html`/`config.html` for the real Twitch-hosted pages (only meaningful once actually loaded inside Twitch — see below).

### Local Test setup

This needs an actual Twitch Developer account and a real extension registered in the [Extensions Developer Console](https://dev.twitch.tv/console/extensions) — the exact console UI (button labels, tab names) changes over time, so treat the steps below as a map, not a script, and follow whatever the console currently shows.

1. Create an extension in the Developer Console and set its type to **Video Overlay**.
2. Twitch requires Local Test assets to be served over **HTTPS**, even on localhost — generate a self-signed cert (e.g. `openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -days 365 -nodes`) and serve `twitch-extension/` with it, for example via `npx http-server -S -C server.crt -K server.key -p 8443` (run `npm run build -w twitch-extension` first so `dist/` exists). Visit the HTTPS URL directly once in your browser first to accept the self-signed certificate warning — Twitch's own iframe load will otherwise fail silently.
3. In the extension's **Asset Hosting** tab, set the Testing Base URI to your local HTTPS origin (must end with a trailing slash, e.g. `https://localhost:8443/`), the Video Overlay viewer path to `viewer.html`, and the config path to `config.html`.
4. On the extension's **Capabilities** tab, enable the **Extension Configuration Service** (required for `config.html`'s `configuration.set`/`configuration.broadcaster` calls to work at all).
5. Set the required relay environment variables and start it: `TWITCH_EXTENSION_CLIENT_ID`, `TWITCH_EXTENSION_SECRET` (base64, from the console), then `npm run start -w relay`.
6. Start the RiftSight browser extension pointed at a RiftAtlas tab (see "Local workflow" above).
7. In the extension's floating panel, set **Session ID (or Twitch test channel ID)** to your actual Twitch channel ID and click **Start publishing**.
8. In the Developer Console, put the extension into **Local Test**.
9. Activate it on your test channel (as a Video Overlay).
10. Open your channel on Twitch as a viewer (a different browser profile or incognito window is the honest way to confirm no RiftSight extension is needed there).
11. Confirm: the extension authorizes (no "waiting for Twitch authorization" diagnostic stuck on screen), the relay logs a `twitch-subscribe` admitted for your channel, and card hitboxes appear over the video, tracking whatever's happening in RiftAtlas after your configured delay.
12. Open **config.html** as the broadcaster (via the extension's own config UI entry point in the console/dashboard) to adjust delay/debug-outlines/source-region/source-aspect-ratio — changes apply to open viewers immediately, no reload.

### Manual test: source-region calibration layouts

Run against `viewer.html`/`config.html` (or the mock harnesses, for iterating without Twitch). For each layout: check normal player size, a resized window, zero and nonzero delay, a rotated card, two overlapping cards, and a public + a hidden card together.

- **Full frame** (`{x:0,y:0,width:1,height:1}`, the default) — behavior is unchanged from before this milestone: hitboxes map 1:1 to RiftAtlas-relative bounds.
- **Right-side layout** (e.g. `{x:0.25,y:0,width:0.75,height:1}`, RiftAtlas occupying the right 75%) — hitboxes shift and scale into that region; nothing renders with `left` below the region's own `x`.
- **Centered layout** (e.g. `{x:0.1,y:0.1,width:0.8,height:0.8}`, the "Centered" preset, borders on all sides) — hitboxes align inside the centered rectangle, none bleeding into the border margins.

All three were exercised live against the real bundle (a stubbed `window.Twitch.ext` + a real relay + real signed JWTs, the same technique used throughout this milestone) with rotated and overlapping public/hidden cards, confirming: mapped positions match `mapBoundsToSourceRegion`'s formula exactly, rotation composes correctly on top of the mapping, hidden cards never leak identity, hitboxes stay percentage-correct across a window resize with no special resize code, and delay/region are independent (an unsatisfiable delay shows nothing regardless of a valid region; resetting delay to 0 brings cards back at the same correctly-mapped positions). Theater mode and fullscreen specifically need a real Twitch iframe to exercise, but rely on the exact same CSS-percentage mechanism already confirmed to be resize-agnostic — see "Iframe/player resizing" in the architecture notes above.

### Known Twitch-specific limitations

- **CSP/hosting:** all assets must be servable under Twitch's iframe sandbox and HTTPS/WSS in production; `RELAY_URL` (`protocol/src/config.ts`) is currently a hardcoded `ws://localhost:8787` constant, not environment-configurable — fine for Local Test, but a real deployment needs that to become a configurable `wss://` origin. No extension secret is ever bundled into any frontend (`relay/src/twitch-auth.ts` is relay-only).
- **Debug outlines are channel-wide, not per-viewer:** the broadcaster config's `debugOutlines` flag applies to every viewer of that channel while it's on (there's no per-viewer-role gating beyond "off by default until the broadcaster explicitly turns it on") — turn it off after you're done testing alignment.
- **Source-region calibration is direct rectangular mapping only, manually set:** no automatic OBS scene-region calibration, no computer-vision board detection, no automatic latency detection, and no contain/cover/crop-edge/letterbox/perspective correction — the broadcaster must select the exact rectangle RiftAtlas occupies. `checkAspectRatioMismatch` only warns (in debug mode) when the RiftAtlas source aspect ratio and the calibrated region's own rendered aspect ratio drift apart beyond a small tolerance; it never corrects anything.
- **The calibration preview's own reference frame is a fixed 16:9 box**, not independently configurable — a broadcaster whose actual canvas isn't 16:9 calibrates by eye against that reference the same way they would in Twitch's own extension config panel.

## Commands

```bash
npm run typecheck   # all packages
npm test             # all packages (vitest)
npm run build        # extension + debug-viewer + twitch-extension (protocol/relay/overlay-core have no build step — they run from source)
npm run dev           # extension watch + relay + debug-viewer, together (twitch-extension's dev server is separate — see "Twitch overlay" above)
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
