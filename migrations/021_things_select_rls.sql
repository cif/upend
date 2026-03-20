-- Replace open SELECT policy with owner-scoped policy (admins see all)
DROP POLICY IF EXISTS things_select_all ON things;

CREATE POLICY things_select_own_or_admin ON things
  FOR SELECT
  USING (
    owner_id = user_id()
    OR (jwt() ->> 'app_role') = 'admin'
  );
