-- Pro subscriptions (from Paddle webhooks) and what a workspace saves. Saved
-- items hold setups without filter values and bridge totals (src/summary.ts);
-- never rows or values from a file.
CREATE TABLE subscription (
  organizationId TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  paddleSubscriptionId TEXT NOT NULL,
  paddleCustomerId TEXT NOT NULL,
  status TEXT NOT NULL,
  priceId TEXT NOT NULL,
  seats INTEGER NOT NULL,
  currentPeriodEnd TEXT,
  lastEventAt TEXT NOT NULL
);

CREATE TABLE saved_setup (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- The file's column names, sorted and joined, so a setup is offered for files with the same columns.
  columnsKey TEXT NOT NULL,
  setup TEXT NOT NULL,
  createdBy TEXT REFERENCES user (id) ON DELETE SET NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX saved_setup_organization ON saved_setup (organizationId, columnsKey);

CREATE TABLE saved_bridge (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  setup TEXT NOT NULL,
  -- Names of filtered columns, so readers know the bridge was filtered; the selected values are not kept.
  filterColumns TEXT NOT NULL,
  createdBy TEXT REFERENCES user (id) ON DELETE SET NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX saved_bridge_organization ON saved_bridge (organizationId, createdAt);
