# RiftSight

Browser extension + relay that overlays live Riftbound (RiftAtlas) card data onto
Twitch/YouTube streams. The streamer's extension reads card state off RiftAtlas's page,
relays it through the backend, and a viewer-side overlay renders hover cards. Card art is
fetched by each viewer straight from RiftAtlas's CDN — it never touches our infra.

> Fan project under Riot's "Legal Jibber Jabber" policy. Not endorsed by Riot.

## Workspaces (npm workspaces monorepo)

- `protocol/`   — shared DOM-free types, validation, privacy serializer, history/recording models. **Imported by both sides — a change here can break extension and viewer together; update callers in the same pass.**
- `relay/`      — the backend: one process, unified HTTP + WebSocket server. SQLite for durable state (broadcaster identity, allowlist, hashed producer creds). Live `OverlayState` is always in-memory only, latest-per-session, no history.
- `extension/`  — MV3 Chromium extension. Content script detects cards; background service worker owns the relay socket.
- `overlay-core/` — DOM-free rendering geometry, tooltip, delayed-live/recording calculators, platform-adapter seam shared by `debug-viewer` and `twitch-extension`.
- `debug-viewer/` — static local page for testing overlays (live / delayed-live / recording).
- `twitch-extension/` — the real Twitch video-overlay frontend (viewer + config entry points).
- `site/` — the marketing/landing site.

Full architecture, diagrams, and the relay-mode matrix live in @README.md — read it when working on the pipeline, not by default.

## Commands (run from repo root)

- Typecheck everything: `npm run typecheck`   (runs `tsc` in every workspace)
- Full test suite: `npm test`                  (vitest, all workspaces)
- Build everything: `npm run build`            (each workspace with a build step)
- Dev (ext + relay + viewer): `npm run dev`
- Package extension: `npm run extension:package`

The relay is a **single Railway replica by design** — session state is in-memory, so a second
replica would see an inconsistent world. Don't add code that assumes horizontal scaling.

Migrations are idempotent and run at relay boot; add new ones under `relay/src/db/`.

## Working agreements

- **Milestone specs (long numbered-requirements messages): do not edit any files until the architecture and first small change are explained and approved.** Inspect read-only first (Plan Mode fits).
- After every implementation step, run `/checkpoint` (typecheck → test → build → verify).
- Never commit directly to `master`. Branch first.
- Record non-obvious design decisions and rejected alternatives in @docs/decisions.md so other sessions don't re-litigate them.
- Large milestones: write the plan to `docs/plans/YYYY-MM-DD-<slug>.md` (see `docs/plans/README.md`) so a fresh conversation can execute it from the file alone.

## Detail docs (read on demand, not preloaded)

- Deployment: `docs/railway-deployment.md`, `docs/operator-runbook.md`
- Scaling posture: `docs/scaling-plan.md`
- Guides: `docs/streamer-guide.md`, `docs/viewer-guide.md`
- Decisions & rationale: `docs/decisions.md`
