# RiftSight — Review Walkthrough (for the Twitch Status tab)

This is meant to be copied directly into the "Walkthrough Guide" field of the
Status tab when submitting for review — that field is plain text, no image
embeds, so keep it as-is rather than linking here. Kept as a repo doc for our
own editing/reference. Replace the bracketed placeholders before submitting.

---

**What RiftSight does**

RiftSight is a Video Overlay extension for Riftbound TCG streams played
through RiftAtlas (riftatlas.com), an unofficial third-party web client for
the game. While a streamer plays, RiftSight shows viewers the full card art
for whatever card is currently on their screen — hover over any visible card
and its art pops up, the same way it would if you picked the physical card up
off a table to read it. No install or account needed on the viewer side.

**Why this needs a live channel to review, not just the config page**

The extension has nothing to show without an active RiftAtlas game running on
the streamer's side — the config page alone only lets you set delay/region/
popup-size preferences, it won't render anything meaningful without a real
game feeding it card data. To see the actual feature, our test channel needs
to be live with RiftAtlas open and a game in progress.

**Review channel:** [JuicyKaraageNo1's Twitch](https://twitch.tv/juicykaraageno1)

**Availability for review (9AM–5PM PT):** Live with a game in
progress on Tuesday, Thursday, and Friday from 11AM to 5PM CDT — reach out if you'd like a specific
window, and we'll make sure we're live then.

**Steps to see it working**

1. Open the review channel above during one of the windows listed.
2. Confirm the extension is visible as a Video Overlay panel over the stream.
3. Hover your mouse over any card visible in the streamer's hand, board, or
   played zones. Its full card art should appear next to your cursor within
   a second or two.
4. If the streamer's configured stream delay is more than a few seconds,
   allow that long after first loading the page before hovering — the
   overlay deliberately waits out the delay so it never shows a snapshot
   that doesn't match what's currently on screen. This is expected, not a
   bug.
5. Cards that are still face-down (an opponent's hand, an unrevealed zone)
   correctly show nothing on hover — RiftSight only ever reveals what's
   already visibly face-up in the streamer's own client, never hidden
   information.

**Configuration (optional to check)**

The broadcaster-facing config page lets a streamer match RiftSight's overlay
region to wherever RiftAtlas actually appears in their stream layout (full
screen, a side panel, or a custom-calibrated box against a real screenshot of
their layout), pick a stream-delay value to match their broadcast software,
and choose a popup size. None of this is required to see the core feature
working — the defaults (full screen, no delay) are enough for the walkthrough
above.

**Contact for questions during review:** riftsight.support@gmail.com
