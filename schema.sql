-- Already applied to the remote toast-tracker D1 database.
-- For local dev: npx wrangler d1 execute toast-tracker --local --file schema.sql
CREATE TABLE IF NOT EXISTS toasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL, -- ms since epoch
  ended_at INTEGER,            -- NULL while toasting
  seconds INTEGER
);
CREATE INDEX IF NOT EXISTS toasts_started ON toasts(started_at);
