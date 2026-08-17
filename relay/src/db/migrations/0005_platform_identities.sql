-- The identity-model correction: RiftSight broadcaster identity becomes the
-- internal broadcasters.id (which producer credentials ALREADY bind to),
-- with Twitch and YouTube demoted to linked external identities in this
-- table. Backfills every existing broadcaster's twitch (and, if claimed,
-- youtube) identity, then rebuilds `broadcasters` down to the neutral core
-- (id + timestamps) so a YouTube-only broadcaster row is representable at
-- all (the old twitch_user_id NOT NULL made it impossible). ids are
-- preserved exactly, so existing producer credentials keep working with no
-- re-registration. Applied as one atomic batch (see migrate.ts).

CREATE TABLE platform_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcaster_id INTEGER NOT NULL REFERENCES broadcasters(id),
  platform TEXT NOT NULL CHECK (platform IN ('twitch', 'youtube')),
  external_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE INDEX idx_platform_identities_broadcaster ON platform_identities(broadcaster_id);

INSERT INTO platform_identities (broadcaster_id, platform, external_id, display_name, created_at, updated_at)
  SELECT id, 'twitch', twitch_user_id, twitch_login, created_at, updated_at FROM broadcasters;

INSERT INTO platform_identities (broadcaster_id, platform, external_id, display_name, created_at, updated_at)
  SELECT id, 'youtube', youtube_channel_id, NULL, created_at, updated_at FROM broadcasters WHERE youtube_channel_id IS NOT NULL;

CREATE TABLE broadcasters_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO broadcasters_new (id, created_at, updated_at) SELECT id, created_at, updated_at FROM broadcasters;

DROP TABLE broadcasters;

ALTER TABLE broadcasters_new RENAME TO broadcasters;

CREATE TABLE youtube_allowlist (
  youtube_channel_id TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  note TEXT
);
