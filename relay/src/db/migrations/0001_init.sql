-- A Twitch account that has completed OAuth account linking (see
-- auth/twitch-oauth.ts, added in a later stage). One row per linked
-- streamer; twitch_login is refreshed on relink since a display name can
-- change but the numeric ID never does.
CREATE TABLE broadcasters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT NOT NULL UNIQUE,
  twitch_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Closed-beta allowlist: which Twitch user IDs may link an account or
-- publish at all. Keyed by ID, never display name — a display name can
-- change or be reused, an ID cannot.
CREATE TABLE twitch_allowlist (
  twitch_user_id TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  note TEXT
);
