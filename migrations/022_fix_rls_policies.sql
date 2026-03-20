-- Force RLS on all tables (neondb_owner has BYPASSRLS, so we need FORCE)
ALTER TABLE things FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE reps FORCE ROW LEVEL SECURITY;

-- Replace Neon auth.user_id() and auth.jwt() with current_setting()
-- since we use SET LOCAL request.jwt.* for RLS context

-- things: select
DROP POLICY IF EXISTS things_select_own_or_admin ON things;
CREATE POLICY things_select_own_or_admin ON things FOR SELECT USING (
  owner_id = current_setting('request.jwt.sub', true)
  OR current_setting('request.jwt.app_role', true) = 'admin'
);

-- things: update
DROP POLICY IF EXISTS things_update_own_or_admin ON things;
CREATE POLICY things_update_own_or_admin ON things FOR UPDATE USING (
  owner_id = current_setting('request.jwt.sub', true)
  OR current_setting('request.jwt.app_role', true) = 'admin'
);

-- things: delete
DROP POLICY IF EXISTS things_delete_own_or_admin ON things;
CREATE POLICY things_delete_own_or_admin ON things FOR DELETE USING (
  owner_id = current_setting('request.jwt.sub', true)
  OR current_setting('request.jwt.app_role', true) = 'admin'
);

-- accounts: owner all
DROP POLICY IF EXISTS "accounts: owner all" ON accounts;
CREATE POLICY "accounts: owner all" ON accounts FOR ALL USING (
  owner_id = current_setting('request.jwt.sub', true)
);

-- contacts: owner all
DROP POLICY IF EXISTS "contacts: owner all" ON contacts;
CREATE POLICY "contacts: owner all" ON contacts FOR ALL USING (
  owner_id = current_setting('request.jwt.sub', true)
);
