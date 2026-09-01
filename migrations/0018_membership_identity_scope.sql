DROP POLICY IF EXISTS membership_identity_read ON memberships;
CREATE POLICY membership_identity_read ON memberships
  FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
