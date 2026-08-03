-- Lifecycle visibility for producer credentials, without enforced expiry
-- (see db/producer-credentials.ts's doc comments for why: a 3-10 streamer
-- closed beta has credentials that are already revocable via rotation and
-- allowlist removal, and adding forced expiry without a complete automatic
-- refresh lifecycle could reduce reliability more than it helps).
--
-- issued_at is deliberately NOT a new column here — producer_credentials'
-- existing created_at (migration 0002) already is that.
ALTER TABLE producer_credentials ADD COLUMN last_used_at TEXT;
ALTER TABLE producer_credentials ADD COLUMN rotated_at TEXT;
