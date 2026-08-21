# Decisions log

Non-obvious design decisions and the alternatives we rejected. The point is to stop a future
session (or a future you) from re-litigating something already settled. Record the *why* and
what was passed over — the code already shows the *what*.

Format: newest first, dated, one decision per entry.

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
