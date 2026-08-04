# RiftSight — Streamer Setup Guide

Welcome to the RiftSight closed beta! This guide is everything you need to get set up. No coding, terminal, or technical knowledge required.

RiftSight lets your viewers hover over cards visible on your stream to see the full card art, live. You just need to install one browser extension and turn on one Twitch extension. RiftSight handles the rest automatically.

## Before you start

Someone on the RiftSight team needs to have already added your Twitch account to the beta. If you haven't heard back that you're in, check with whoever invited you before continuing.

## Step 1 — Install the RiftSight browser extension

1. Download and unzip the `riftsight-extension-closed-beta.zip` file you were given.
2. Open a new Chrome tab and go to `chrome://extensions`.
3. Turn on **Developer mode** — there's a toggle in the top-right corner of that page.
4. Click **Load unpacked**.
5. Select the folder you unzipped in step 1.

You should now see a purple RiftSight icon appear in your Chrome toolbar (top-right, near the address bar). If you don't see it, click the puzzle-piece icon in the toolbar and pin RiftSight so it's always visible.

## Step 2 — Connect your Twitch account

1. Click the RiftSight icon in your toolbar. A small panel opens.
2. Click **Connect Twitch**.
3. A new tab opens asking you to authorize RiftSight on Twitch. Click through it.
4. Once it says "Connected," you can close that tab and go back to the RiftSight panel.
5. The panel should now say **Connected as `<your Twitch username>`**.

If it instead says your account isn't part of the beta yet, you weren't added in time — reach out to whoever invited you.

## Step 3 — Open RiftAtlas and start publishing

1. Open RiftAtlas in a browser tab, like you normally would.
2. Click the RiftSight icon again. Under "RiftAtlas," it should say **RiftAtlas detected** once you're in an active game.
3. Click **Start publishing**. You should be a green indicator in the bottom right of the RiftSight extension icon that confirms you're successfully publishing.

That's it — RiftSight is now watching your game and will send card info to your viewers automatically. You don't need to keep the panel open; it'll keep working in the background as long as RiftAtlas stays open.

## Step 4 — Turn on the RiftSight extension on your Twitch channel

This is a separate, one-time setup step on Twitch's own side:

1. Go to your Twitch Creator Dashboard → **Extensions** → **My Extensions**.
2. Find **RiftSight** and activate it.
3. Assign it to a **Video Overlay** slot.

## Step 5 — A couple of quick settings

Twitch gives every extension its own settings page. Open RiftSight's settings from your dashboard (same Extensions area as step 4) and set two things:

- **Delay**: set this to match whatever stream delay you use in OBS/your broadcast software. If you're not sure, leave it at 0 — you can adjust it later.
- **Source-region calibration**: if RiftAtlas fills your entire stream (no webcam overlay, no other panels around it), you don't need to touch this. If RiftAtlas only takes up part of your screen, drag the box in the preview to match where RiftAtlas actually appears on your stream. Note: It can be helpful to enable Debug outlines to see the exact card hover hitbox positions in the current overlay.

## Step 6 — Go live and check it's working

Start your stream as normal. Then, from a **separate device or account** (not your own streamer account), open your channel and hover over a visible card. You should see its full art pop up. Note: RiftSight is currently only supported on Chromium browsers.

## Understanding the RiftSight icon

The RiftSight icon in your toolbar has a small colored dot that tells you the status at a glance, even without opening the panel:

| Color | Meaning |
|---|---|
| ⚪ Gray | Not connected to Twitch yet |
| 🟡 Yellow | Connected, but not currently publishing |
| 🟢 Green | Actively publishing — everything's working |
| 🔴 Red | Connected, but having trouble reaching RiftSight right now (it'll keep retrying automatically) |

## Common questions

**Do I need to click "Start publishing" every time I stream?**
No. Once you've clicked it, RiftSight remembers — it survives closing RiftAtlas, reloading the page, restarting your browser, everything. It automatically pauses when you're not in an active game and resumes when you are. You only need to click **Stop publishing** if you actually want it off.

**Do my viewers need to install anything?**
No. Only you (the streamer) install the browser extension. Viewers just need the RiftSight extension active on your channel — Twitch handles the rest for them automatically.

**Something looks wrong / a card isn't showing correctly.**
Reach out to whoever invited you to the beta with as much detail as you can — what card, what you expected vs. what you saw, and roughly when it happened. See the [viewer guide](viewer-guide.md) if you want to know what your viewers should be checking too.

**Do I need to keep any terminal window or program running?**
No — just your browser, with RiftAtlas open and the RiftSight extension installed.
