-- The streamer-claimed YouTube channel this broadcaster's overlay session
-- is reachable under (see docs: YouTube viewers resolve a watch page's
-- channel id to a broadcaster session through this column). Nullable — a
-- broadcaster who never streams on YouTube simply never sets it. The
-- partial UNIQUE index enforces one broadcaster per channel (a second
-- claim is a 409 at the API layer, and a race that slips past the
-- pre-check still fails here) while letting any number of rows keep NULL.
ALTER TABLE broadcasters ADD COLUMN youtube_channel_id TEXT;

CREATE UNIQUE INDEX idx_broadcasters_youtube_channel
  ON broadcasters(youtube_channel_id)
  WHERE youtube_channel_id IS NOT NULL;
