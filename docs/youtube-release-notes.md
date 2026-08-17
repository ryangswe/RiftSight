# YouTube support — release/ops notes

Working notes for shipping the `youtube-live` milestone. The feature is
**inert until released**: the relay's youtube-subscribe path only serves
channels a broadcaster has explicitly claimed, and no installed extension
runs on youtube.com until its user grants the optional permission.

## Chrome Web Store update

- The manifest adds `"scripting"` to `permissions` and
  `"*://www.youtube.com/*"` to `optional_host_permissions`. Because the
  YouTube origin is **optional**, existing installs are NOT disabled
  pending re-approval on update — the guarantee is locked in by
  `extension/src/build-manifest.test.ts` ("youtube.com is an OPTIONAL host
  permission in every mode"). Chrome review may still take longer than a
  plain code update because of the permission-surface change.
- Store listing: mention that YouTube support is opt-in ("Click Enable
  RiftSight on YouTube — the extension only runs on youtube.com after you
  allow it, and only activates on live streams from RiftSight streamers").

Draft permission-justification text for the listing/review form:

> The optional youtube.com permission powers viewer-side overlays on
> YouTube live streams: the extension reads the watch page's public
> channel id to find the matching RiftSight broadcaster session and draws
> interactive card previews over the video. It is requested at runtime
> only when the user clicks "Enable RiftSight on YouTube", runs only on
> live watch pages, and reads no user data — no browsing history, no
> account information, no page content beyond the player and the page's
> own public channel metadata. The `scripting` permission exists solely to
> register/unregister that YouTube content script when the user toggles
> the optional permission.

## Relay deployment

- No new environment variables and no schema-breaking changes. Migration
  `0004_youtube_channels.sql` applies automatically on boot
  (single-replica) or via `npm run migrate -w relay` in multi-replica
  deployments — same rules as every migration (see railway-deployment.md).
- New public surface to watch: `youtube-subscribe` admits **anonymous**
  viewer sockets for claimed channels. Guardrails shipped with it: per-IP
  WebSocket connection limiting (keyed on first `X-Forwarded-For` hop —
  correct behind Railway's proxy), a per-session viewer cap (default
  2000/instance, `at-capacity` rejection), channel-id format validation
  before any DB touch, and a 30s resolution cache so a viewer storm on one
  channel costs ~2 DB lookups a minute. `capacity_snapshot` log lines are
  the load signal (see scaling-plan Stage 4).
- Keepalive pings (`{"type":"ping"}`, ~20s) flow to youtube-path viewers
  only — expect that steady background send rate per connected viewer when
  eyeballing traffic.

## Known deferrals (deliberate)

- **No YouTube channel-ownership verification** — claims are gated only by
  the producer-credential auth (i.e. the beta allowlist) plus a uniqueness
  constraint, and logged (`youtube_channel_request`). Revisit (YouTube
  OAuth) before open registration.
- Live streams only (no VODs), UC-id input only (no @handle resolution),
  Chrome-family browsers only, Twitch viewer does not consume the
  wire-carried config yet (its config service remains authoritative).

## Real-stream test checklist (needs real Chrome + a real live stream)

The sandbox verification covered everything except real YouTube DOM and
real extension packaging. Before announcing:

1. Load the unpacked closed-beta build; grant YouTube via the popup.
2. On a real **live** watch page: overlay appears; `meta[itemprop=
   "channelId"]` extraction works; player chrome (controls, gradients)
   sits above/below the overlay sensibly; theater + fullscreen track.
3. On a VOD and on another channel's live stream: nothing renders.
4. Card art loads in the popup on youtube.com (if YouTube's page CSP ever
   blocks the art host, the fallback label shows instead — the fix would
   be fetching art in the background worker; not built, expected not
   needed).
5. SPA-navigate live→VOD→live: overlay detaches/reattaches.
6. Claim/clear channel round-trip against the production relay.

## Identity-model refactor (cross-platform client milestone)

The relay's broadcaster identity is now the internal `broadcasters.id`
(platform-neutral, opaque), with Twitch and YouTube demoted to linked
identities in `platform_identities` (migration
`0005_platform_identities.sql`). Operational consequences:

- **Deploying 0005**: apply BEFORE any Turso cutover (the migration runner
  suspends FK enforcement via a connection-level PRAGMA, which the local
  sqlite3/file driver honors; remote libsql may not — see
  `db/migrate.ts`'s comment). Existing broadcasters keep their ids,
  credentials, and allowlist status; nobody re-registers. Verified by
  `db/migration-0005.test.ts` against legacy-shaped rows.
- **Session keys changed**: relay sessions now key on the internal
  broadcaster id, and BOTH viewer paths (Twitch JWT channel_id, YouTube
  channel id) resolve through `platform_identities`. In-memory sessions
  don't survive restarts anyway; pre-upgrade Redis snapshot keys age out
  via TTL. A Twitch channel with no linked broadcaster no longer creates
  empty sessions per curious viewer.
- **Allowlists**: `twitch_allowlist` is untouched; `youtube_allowlist`
  (new) gates YouTube-only onboarding. A broadcaster is permitted if ANY
  linked identity is allowlisted — removal on the relevant platform still
  revokes producer access. CLI: `seed-allowlist add-youtube <UC...>` /
  `remove-youtube <UC...>`.
- **Verified YouTube linking (Google OAuth)** is code-complete and INERT:
  provision a Google Cloud project (YouTube Data API v3 + OAuth consent
  screen, scope `youtube.readonly`), set
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_URI`
  (`https://<backend>/auth/google/callback`), and `/auth/google/*` goes
  live — a YouTube-only streamer then onboards with zero Twitch. Until
  then those routes 503 and the manual channel claim (now in the popup's
  Settings view, labeled beta) is the only YouTube attach path.
- **Known deferral**: attaching a SECOND platform to an existing account
  via OAuth (e.g. Twitch-linked streamer adding verified YouTube) isn't
  wired — the manual claim covers YouTube attach; Twitch-attach for
  YouTube-first accounts shows "coming soon" in the UI. Needs a
  bearer-authed one-time attach-code flow; deliberately out of scope.

## Popup (cross-platform client)

The popup is now Watch | Stream tabbed with a first-run chooser (sets the
default tab only), a settings view holding account/linking admin, and
state-driven views throughout (`popup/view-model.ts`, unit-tested).
Viewers see no streamer machinery by default and need no account; the
YouTube host permission is only ever requested from an explicit user
action (onboarding "Watch" choice or the Watch tab's enable CTA).
