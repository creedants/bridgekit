-- One row per invitation email the app tries to send, so a workspace can be
-- held to 20 sends in any rolling 24 hours. server/worker.ts refuses before
-- Better Auth runs, but two requests in different isolates can both pass that
-- check at 19 sends; the guard on the ledger's insert is where the last of them
-- is refused. The abort rolls back the invitation insert or expiry change
-- that fired it, so the refused write changes no invitation and sends no email.
--
-- The ledger records sends, not invitations: a new invitation is one row
-- written by Better Auth's insert, and a resend is one update of `expiresAt`
-- on the pending row that sends the email again and writes no invitation row.
-- Rows leave with the workspace through the foreign key. `invitationId`
-- carries no foreign key, so deleting an inviter cannot refund a send.
--
-- Applying this migration changes no existing row: it adds one table, one
-- index and three triggers, and the triggers write only the new table.

CREATE TABLE invitation_send (
  organizationId TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  invitationId TEXT NOT NULL,
  sentAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX invitation_send_window ON invitation_send (organizationId, sentAt);

-- The one guard: the 21st send inside any rolling 24 hours. Its marker is the
-- sentence server/workspace.ts holds, which the Worker answers with.
CREATE TRIGGER invitation_send_limit BEFORE INSERT ON invitation_send
WHEN (
  SELECT COUNT(*) FROM invitation_send
  WHERE organizationId = NEW.organizationId
    AND sentAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
) >= 20
BEGIN
  SELECT RAISE(ABORT, 'This workspace has sent 20 invitations in the last 24 hours. Try again tomorrow.');
END;

-- A new invitation is a send.
CREATE TRIGGER invitation_send_on_create AFTER INSERT ON invitation
BEGIN
  INSERT INTO invitation_send (organizationId, invitationId) VALUES (NEW.organizationId, NEW.id);
END;

-- A resend is a send: Better Auth moves the live pending row's expiry forward
-- and emails again, and the resend branch is the only statement that writes
-- expiresAt. A cancel that lands between that read and that write leaves the
-- status "canceled" while the email still goes, so this trigger reads the
-- expiry alone and never the status. Accept, cancel and reject write no expiry.
CREATE TRIGGER invitation_send_on_resend AFTER UPDATE OF expiresAt ON invitation
WHEN julianday(NEW.expiresAt) > julianday('now')
BEGIN
  INSERT INTO invitation_send (organizationId, invitationId) VALUES (NEW.organizationId, NEW.id);
END;
