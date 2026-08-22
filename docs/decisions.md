# Decisions log

Non-obvious design decisions and the alternatives we rejected. The point is to stop a future
session (or a future you) from re-litigating something already settled. Record the *why* and
what was passed over — the code already shows the *what*.

Format: newest first, dated, one decision per entry.

---

## 2026-08-22 — Scaling cutover (Turso + Redis + replicas) runs on master BEFORE the YouTube milestone; 0005 must become additive

The post-tournament numbers (one channel >2k viewers, ~500 MB RAM, 0.1
vCPU, $7.59 total) say capacity isn't the driver; the remaining Stage 2+
work is about durability (a hosted DB instead of one SQLite file on one
volume that also forces downtime on every redeploy) and resilience
(replicas). Decided: execute it on today's master, deferring the
`youtube-live` merge. Reasons: master's migrations are purely additive
(no PRAGMA), so they apply cleanly against remote libsql; the only
scalability-relevant code on youtube-live (connection hardening) is
already on master; and a big feature merge should not ride along with an
infrastructure cutover.

**Consequence for youtube-live:** migration 0005 rebuilds `broadcasters`
(DROP + rename) under an FK-suspension PRAGMA that remote libsql may not
honor, and it is the first non-rollback-safe migration. Before that
branch merges it must be re-authored additively — create
`platform_identities` + backfill, leave the legacy `broadcasters` columns
in place and unused — which makes it both Turso-safe and rollback-safe.

**Tooling added** (all on master): `TURSO_AUTH_TOKEN` as its own env var
(never inside the URL, so no future config log can leak it; closed-beta
refuses a remote URL without it), `relay/src/db/copy.ts` + `copy-db`
(strict row copy: ids preserved, refuses unmigrated/behind/unknown-table
/non-empty targets, `--force` re-copy, count verification), the preflight
harness promoted to master, `railway.staging.json` for the spike, and soak
harness fixes (it was sampling the tsx wrapper's pid and orphaning relay
processes).

**Rejected:** token-in-URL (`?authToken=` works but puts a secret in
`dbUrl`); copying schema_migrations rows (the target must be migrated by
the real runner, and the copy verifies it's not behind instead); a generic
"copy every table" (a new migration's table would be silently skipped —
the explicit list fails loudly instead).

---

## 2026-08-21 — Multiple RiftAtlas tabs: publish only the active tab, elected in the background worker

A streamer rapidly switching between several spectated games keeps multiple
RiftAtlas tabs open. Each tab's content script runs its own detector and
`OverlayStatePublisher`, but the MV3 background worker owns a single relay
producer socket — so every tab's OverlayState was forwarded over that one
socket with no arbitration, and viewers saw whichever tab published last (a
background tab's board leaking onto the stream). It surfaced during the
tournament as the wrong board on-stream after a rapid tab switch.

Decided: the background worker elects one "active" tab and forwards only its
state. Election is fully automatic — content scripts report visibility/focus
on the existing heartbeat (and fire an *immediate* heartbeat on
visibilitychange/focus/blur so a switch registers in well under the 5s beat),
and `electActiveTab` (pure, `extension/src/background/presence.ts`) picks the
visible, most-recently-switched-to tab. A lone tab always wins regardless of
visibility, so single-tab — and OBS-capturing-a-backgrounded-tab — behavior is
unchanged. On an election flip the worker immediately re-sends the newly
active tab's last board so viewers snap to the right game without waiting for
its next board mutation.

The subtler half: viewers buffer states by `capturedAt` and reject any push
that moves backward in time (`protocol/src/history.ts`'s
`TimeWindowBuffer.push`). Each tab stamps its own `capturedAt`, so snapping to
a tab whose last board was captured *earlier* than the tab just left was
silently dropped, freezing viewers on the old board (the config-panel preview
looked correct because it reads the relay's stored latest state directly,
bypassing that buffer). Fix: the single producer socket now clamps
`capturedAt` so it never regresses (`background.ts` `send()`), and the snap
re-stamps it to now — the socket is one monotonic timeline no matter which tab
produced each frame.

Expected behavior: after a switch, viewers follow the active tab within a
heartbeat; with a configured stream delay the overlay switches after that
delay (correct delayed-live), so at most a second or two of mismatch when no
delay is set.

**Rejected:** a manual "publish from this tab" pin in the popup (automatic
matches "detect the active tab" and needs no new UI; a pin stays a fallback
only if OBS-captures-an-unfocused-tab turns out common in practice); rewriting
the per-publisher `sequence` too (viewers gate on `capturedAt`, not
`sequence`, so it wasn't the cause — left alone to avoid scope creep);
relay-side arbitration (the stomp happens inside the extension, before the
relay's one-producer-per-session logic could ever apply — it's still one
socket from the relay's view).

---

## 2026-08-20 — perMessageDeflate rejected at high fan-out; connection hardening ported to master for the 6k-viewer tournament

A 4,000-socket soak (realistic 40-card/20 KB payload, 3 Hz, soak harness
with RELAY_WS_CONN_PER_MIN raised) measured ws perMessageDeflate at
tournament-scale fan-out: relay RSS tripled (~150-170 MB -> ~490-505 MB)
and delivery queued seconds deep (mean latency ~12 s, max 25 s, delivered
throughput halved) vs. a clean uncompressed baseline (p99 500 ms, zero
drops). Root cause: permessage-deflate compresses PER SOCKET PER MESSAGE
— no shared compression across recipients — so fan-out multiplies zlib
work and queue depth by the socket count. Caveat: the single-machine soak
driver (decompressing ~10k msg/s in one process) confounds the latency
number; re-test on prod-like hardware with a distributed driver before
ever revisiting.

Decided: ship the connection hardening alone (`relay-hardening` branch ->
master: per-IP WS upgrade limit 60/min close-4429, env-tunable via
RELAY_WS_CONN_PER_MIN; per-session viewer cap 2,000/instance, silent
rejection) and rely on the existing graceful shedding (4 MiB
slow-consumer terminate + viewer auto-reconnect) for the 6,000-viewer
tournament. Uncompressed 4k-socket baseline is comfortably within one
replica (~160 MB RSS, low CPU, zero gaps); the cost is egress dollars
(~$30-45/day), not stability.

**Consequences for earlier decisions:** the 2026-08-17/19 assumption that
"deflate is the cheap first egress lever" is measured FALSE at high
fan-out — the egress-reduction ladder is now: (1) nothing (shedding is
graceful, egress is just money), (2) compress-once-broadcast-raw (needs
custom framing ws doesn't expose — real work), (3) Twitch PubSub per the
2026-08-17 entry, whose trigger conditions should no longer assume a
post-deflate baseline.

**Rejected:** shipping the flag dormant (a measured-bad capability behind
an env var invites enabling it mid-incident); enabling at lower scale
(egress doesn't matter there anyway).

---

## 2026-08-17 — Twitch Extension PubSub delivery: rejected for now, revisit only on measured triggers

Evaluated moving Twitch viewer delivery from relay WebSockets to Twitch
Extension PubSub (EBS -> Helix broadcast -> Twitch.ext.listen; full analysis
with verified Twitch constraints in the 2026-08 architecture evaluation).
Decided: keep relay WS primary; ship egress instrumentation now
(`relay-instrumentation` branch: outBytes on state_broadcast, egressBytes
on capacity_snapshot, snapshot_lookup hit/miss); enable ws
perMessageDeflate when egress first matters; build PubSub only if ALL of:
post-deflate egress > ~$50/mo sustained (or >2,000 sustained concurrent
Twitch viewer sockets), p99 production state re-encodes under 4.5 KB
compact, and a frontend version is already shipping for other reasons
(ride-along review, never a dedicated submission).

**Why:** measured payloads (~20 KB/40-card board) exceed PubSub's 5 KB cap
as encoded; the effective rate is ~1 msg/s + 40 burst (token bucket, not
the documented 100/min window); delivery is best-effort with no
retention, forcing an HTTP snapshot/resync surface anyway; every viewer
PubSub iteration re-enters Twitch review; and YouTube viewers ride relay
WS forever, so WS scaling investment serves all platforms while PubSub
serves one platform's desktop fraction.

**Rejected:** PubSub before launch (new viewer code days before the first
big stream); per-state WS-fallback-on-oversize (retains all socket load
or thundering-herds the relay exactly when boards get big — if PubSub is
ever built, degrade within PubSub: geometry-complete, identity top-K,
hover-time identity fetch); deltas over PubSub (corruption windows on a
lossy unordered transport — compact full snapshots self-heal);
hlsLatencyBroadcaster as the sync mechanism (absent in popout, documented
absurd values — clamped default hint at most); pure template derivation
of imageUrl from cardId (the ?v= is a per-card content hash — send
template prefix + 16-hex hash field instead).

---

## 2026-08-19 — First 1,000+-viewer stream runs on the single replica; egress, not replicas, is the scaling lever

Measured (docs/scaling-plan.md "Single-instance capacity"): one relay
process handles 2,000 viewers at 3 updates/s with ~160 MB RSS and low CPU;
the real ceiling is egress (full-state JSON to every viewer per change,
~15 KB × viewers × rate). Decided: no production posture change before
the stream — pre-flight the real path with `preflight-viewers` instead,
and execute the Stage 2+ operator checklist afterwards.

**Rejected:** cutting over to Redis/Turso/multi-replica the day before (all
risk, no capacity gain at this scale); delta states as the egress fix
(frontend change → Twitch re-review). If egress binds first, enable ws
`perMessageDeflate` (backend-only) before adding replicas.

---

## 2026-08 — Relay stays a single Railway replica

Per-channel session state lives in memory, not a shared store, so a second replica would
silently serve an inconsistent world. SQLite (persistent volume) holds only what must survive
a restart: linked broadcaster identities, the beta allowlist, hashed producer credentials —
never live game state, which is republished fresh on every reconnect.

**Rejected:** horizontal scaling / shared session store — not worth the complexity at beta scale;
see `docs/scaling-plan.md` for the conditions that would change this.

---

## 2026-08 — Separate OAuth flows for Twitch and YouTube

Account linking allows independent OAuth for Twitch and YouTube rather than a single unified
flow, and the extension distinguishes stream vs. watch surfaces.

<!-- Backfill the rationale and any rejected approach here while it's fresh. -->

---

<!--
Template for new entries:

## YYYY-MM-DD — <one-line decision>

<what was decided, in 2-4 sentences>

**Rejected:** <alternative> — <why>.
-->
