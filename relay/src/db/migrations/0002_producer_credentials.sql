-- RiftSight's own opaque producer credential, scoped to one linked
-- broadcaster — see auth/producer-credential.ts. Only the SHA-256 hash is
-- ever stored; the raw token is shown to the extension exactly once, at
-- issuance/rotation time.
CREATE TABLE producer_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcaster_id INTEGER NOT NULL REFERENCES broadcasters(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_producer_credentials_broadcaster ON producer_credentials(broadcaster_id);
