-- Daily page counts (server/counts.ts). No visitor details.
CREATE TABLE page_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  referrer TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (day, path, referrer)
);
