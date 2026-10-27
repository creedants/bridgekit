-- One commentary request count per member per UTC day, the second limit
-- server/commentary.ts holds on POST /api/commentary for Pro members. The
-- 5-per-60-seconds COMMENTARY_RATE_LIMIT binding in server/worker.ts is held
-- per isolate by Cloudflare, so it caps how fast one member can ask and not
-- what a day costs; this row is shared by every isolate, so the count holds.
--
-- Applying this migration changes no existing row: it adds one table, and no
-- other statement reads or writes it. `requests` carries no CHECK, because the
-- limit of 100 lives once in server/commentary.ts and a second copy here could
-- drift from the sentence the Worker answers. `day` is the Worker's UTC date
-- from new Date().toISOString(), written by server/commentary.ts, not SQLite's
-- date('now'), so the day boundary is the same in every isolate and a test can
-- choose it. Deleting a user deletes their counts.
CREATE TABLE commentary_daily (
  userId TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (userId, day)
);
