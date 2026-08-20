# Decisions log

Non-obvious design decisions and the alternatives we rejected. The point is to stop a future
session (or a future you) from re-litigating something already settled. Record the *why* and
what was passed over — the code already shows the *what*.

Format: newest first, dated, one decision per entry.

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
