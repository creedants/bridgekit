-- The one limit Better Auth's organization plugin cannot hold on its own: a
-- workspace may seat as many people as it pays for, members and live pending
-- invitations together. server/worker.ts refuses before Better Auth runs and
-- the hooks in server/auth.ts refuse inside it, but two invitations that
-- arrive at the same moment pass both and then both write. The database sees
-- both, so the losing statement is refused here.
--
-- A trigger may only refuse the statement that fired it. Nothing in this
-- migration reads, changes or deletes an existing row: applying it adds one
-- view and two triggers, and every row is left exactly as it was. The two
-- triggers then run on every invitation write afterwards, and they refuse
-- that write with RAISE(ABORT) instead of undoing it, so the request that
-- lost the race answers with the sentence below and sends no email.

-- The seats a workspace pays for right now, the same rule plan() applies in
-- server/workspace.ts: paid seats while the subscription pays, otherwise one,
-- which is the owner's. A workspace with no subscription row has one.
CREATE VIEW workspace_seats AS
SELECT organizationId,
  CASE
    WHEN status IN ('active', 'trialing', 'past_due') THEN seats
    WHEN status = 'canceled'
      AND currentPeriodEnd IS NOT NULL
      AND datetime(currentPeriodEnd) > datetime('now') THEN seats
    ELSE 1
  END AS seats
FROM subscription;

-- An invitation the workspace has no seat for, at the moment it is written.
-- Current members and the live invitations already pending each hold a seat,
-- and this one would take another. The marker text is the refusal sentence
-- server/workspace.ts holds, which the Worker answers when this abort reaches it.
CREATE TRIGGER invitation_seat_limit BEFORE INSERT ON invitation
WHEN NEW.status = 'pending'
  AND datetime(NEW.expiresAt) > datetime('now')
  AND (
    SELECT COUNT(*) FROM member WHERE organizationId = NEW.organizationId
  ) + (
    SELECT COUNT(*) FROM invitation
    WHERE organizationId = NEW.organizationId
      AND status = 'pending'
      AND datetime(expiresAt) > datetime('now')
  ) + 1 > COALESCE((
    SELECT seats FROM workspace_seats WHERE organizationId = NEW.organizationId
  ), 1)
BEGIN
  SELECT RAISE(ABORT, 'This workspace has no free seat, so cancel a pending invitation or add seats.');
END;

-- A re-send moves a live pending invitation's expiry into the future without
-- inserting a row, so the same check runs on that update. The invitation being
-- re-sent already holds its seat and is not counted again; every other live
-- invitation is. An update that changes the status instead, which is what
-- accepting, cancelling or rejecting does, never takes a seat and is never
-- refused here.
CREATE TRIGGER invitation_seat_resend BEFORE UPDATE ON invitation
WHEN NEW.status = 'pending'
  AND datetime(NEW.expiresAt) > datetime('now')
  AND (
    SELECT COUNT(*) FROM member WHERE organizationId = NEW.organizationId
  ) + (
    SELECT COUNT(*) FROM invitation
    WHERE organizationId = NEW.organizationId
      AND status = 'pending'
      AND datetime(expiresAt) > datetime('now')
      AND id <> OLD.id
  ) + 1 > COALESCE((
    SELECT seats FROM workspace_seats WHERE organizationId = NEW.organizationId
  ), 1)
BEGIN
  SELECT RAISE(ABORT, 'This workspace has no free seat, so cancel a pending invitation or add seats.');
END;
