-- Posts waiting to be published by the every-minute cron.
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id            TEXT PRIMARY KEY,           -- sp_xxxxxxxx
  member_sub    TEXT NOT NULL,              -- LinkedIn member id
  run_at        INTEGER NOT NULL,           -- epoch ms (UTC)
  publish_at    TEXT NOT NULL,              -- the time as the user gave it, e.g. 2026-11-08T09:00:00+05:30
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | publishing | published | failed | cancelled
  preview       TEXT NOT NULL,              -- first ~80 characters, for listing
  payload       TEXT NOT NULL,              -- AES-GCM encrypted JSON: post content + LinkedIn token
  attempts      INTEGER NOT NULL DEFAULT 0,
  post_urn      TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts (status, run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_member ON scheduled_posts (member_sub, run_at);
