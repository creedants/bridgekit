-- The limits Better Auth's organization plugin cannot hold on its own: three
-- owned workspaces per account and one paid seat per invitation. Both are
-- enforced here, in the database, because two requests that arrive at the same
-- moment pass the same check and then both write. The hooks in server/auth.ts
-- stay where the plain sentence comes from.
--
-- Each trigger undoes the write that would break a limit, so the request that
-- lost the race finds nothing behind the row it was told about and answers
-- with the ordinary refusal. No existing row is read, changed or deleted.

-- A fourth workspace this account owns. Memberships in other people's
-- workspaces do not count, and the plugin stores roles comma-separated.
CREATE TRIGGER workspace_owner_limit AFTER INSERT ON "member"
WHEN instr(',' || replace(NEW.role, ' ', '') || ',', ',owner,') > 0
 AND (
   SELECT COUNT(DISTINCT organizationId) FROM "member"
   WHERE userId = NEW.userId
     AND instr(',' || replace(role, ' ', '') || ',', ',owner,') > 0
 ) > 3
 AND (SELECT COUNT(*) FROM "member" WHERE organizationId = NEW.organizationId) <= 1
BEGIN
  -- The workspace was created in this same request and holds nobody else, so
  -- it goes with the membership that was refused.
  DELETE FROM organization WHERE id = NEW.organizationId;
END;

-- An invitation the workspace has no paid seat for. Current members and the
-- live invitations other than this one each hold a seat, and an expired or
-- cancelled invitation holds none. The seat count repeats plan() in
-- server/workspace.ts: paid seats while the subscription pays, otherwise one.
CREATE TRIGGER invitation_seat_limit AFTER INSERT ON invitation
WHEN NEW.status = 'pending'
 AND datetime(NEW.expiresAt) > datetime('now')
 AND (
   SELECT COUNT(*) FROM "member" WHERE organizationId = NEW.organizationId
 ) + (
   SELECT COUNT(*) FROM invitation
   WHERE organizationId = NEW.organizationId
     AND status = 'pending'
     AND id <> NEW.id
     AND datetime(expiresAt) > datetime('now')
 ) + 1 > COALESCE((
   SELECT CASE
     WHEN status IN ('active', 'trialing', 'past_due') THEN seats
     WHEN status = 'canceled'
       AND currentPeriodEnd IS NOT NULL
       AND datetime(currentPeriodEnd) > datetime('now') THEN seats
     ELSE 1
   END FROM subscription WHERE organizationId = NEW.organizationId
 ), 1)
BEGIN
  DELETE FROM invitation WHERE id = NEW.id;
END;

-- The resend path updates a pending invitation's expiry without asking the
-- hook, so the same seat check runs on an update. Putting the row back as it
-- was leaves the row and its expiry exactly where they were.
CREATE TRIGGER invitation_seat_resend AFTER UPDATE ON invitation
WHEN NEW.status = 'pending'
 AND datetime(NEW.expiresAt) > datetime('now')
 AND (
   SELECT COUNT(*) FROM "member" WHERE organizationId = NEW.organizationId
 ) + (
   SELECT COUNT(*) FROM invitation
   WHERE organizationId = NEW.organizationId
     AND status = 'pending'
     AND id <> NEW.id
     AND datetime(expiresAt) > datetime('now')
 ) + 1 > COALESCE((
   SELECT CASE
     WHEN status IN ('active', 'trialing', 'past_due') THEN seats
     WHEN status = 'canceled'
       AND currentPeriodEnd IS NOT NULL
       AND datetime(currentPeriodEnd) > datetime('now') THEN seats
     ELSE 1
   END FROM subscription WHERE organizationId = NEW.organizationId
 ), 1)
BEGIN
  UPDATE invitation SET expiresAt = OLD.expiresAt WHERE id = NEW.id;
END;
