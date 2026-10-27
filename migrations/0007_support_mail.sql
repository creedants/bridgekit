-- Mail sent to the support address. Email Routing hands each message to the
-- Worker (server/support.ts), which forwards it to the owner's inbox and keeps
-- this copy so a reply can be drafted from it. Mail a person did not write
-- (bounces, auto-replies, mailing lists, no-reply senders) is forwarded and
-- not kept here.
--
-- Only the plain text of the body is kept: no attachment and no HTML. A
-- message with HTML only keeps the text with its tags removed. bodyCut is 1
-- when the body column holds less than the message's whole text: the text was
-- longer than the limit and holds its start, or the message was too large or
-- malformed to read and the body is empty. The body limit and the 90 days live
-- once in server/support.ts, so neither is a CHECK here. The header columns
-- hold the message's own header values as sent and are null when it has none.
-- receivedAt is the Worker's new Date().toISOString(), not SQLite's clock, so
-- it compares with the cutoff the daily scheduled run computes the same way,
-- and the index on it serves that purge.
--
-- Applying this migration changes no existing row: it adds one table and one
-- index, and no other statement reads or writes them.
CREATE TABLE support_mail (
  id TEXT PRIMARY KEY,
  receivedAt TEXT NOT NULL,
  envelopeFrom TEXT NOT NULL,
  envelopeTo TEXT NOT NULL,
  headerFrom TEXT,
  subject TEXT,
  headerDate TEXT,
  messageId TEXT,
  inReplyTo TEXT,
  body TEXT NOT NULL,
  bodyCut INTEGER NOT NULL
);
CREATE INDEX support_mail_received ON support_mail (receivedAt);
