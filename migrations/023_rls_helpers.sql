-- Helper functions for RLS policies
-- These wrap current_setting() so policies read cleanly

CREATE OR REPLACE FUNCTION current_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.sub', true)
$$;

CREATE OR REPLACE FUNCTION current_user_role() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.app_role', true)
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.app_role', true) = 'admin'
$$;

-- Rewrite all policies to use the helpers

-- things
DROP POLICY IF EXISTS things_select_own_or_admin ON things;
CREATE POLICY things_select ON things FOR SELECT USING (
  owner_id = current_user_id() OR is_admin()
);

DROP POLICY IF EXISTS things_update_own_or_admin ON things;
CREATE POLICY things_update ON things FOR UPDATE USING (
  owner_id = current_user_id() OR is_admin()
);

DROP POLICY IF EXISTS things_delete_own_or_admin ON things;
CREATE POLICY things_delete ON things FOR DELETE USING (
  owner_id = current_user_id() OR is_admin()
);

-- accounts
DROP POLICY IF EXISTS "accounts: owner all" ON accounts;
CREATE POLICY accounts_owner ON accounts FOR ALL USING (
  owner_id = current_user_id()
);

-- contacts
DROP POLICY IF EXISTS "contacts: owner all" ON contacts;
CREATE POLICY contacts_owner ON contacts FOR ALL USING (
  owner_id = current_user_id()
);

-- users
DROP POLICY IF EXISTS users_read ON users;
CREATE POLICY users_read ON users FOR SELECT USING (true);

DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users FOR UPDATE USING (
  id = current_user_id() OR is_admin()
);

DROP POLICY IF EXISTS users_admin_update ON users;
DROP POLICY IF EXISTS users_admin_delete ON users;
DROP POLICY IF EXISTS users_admin_insert ON users;

CREATE POLICY users_admin_insert ON users FOR INSERT WITH CHECK (is_admin());
CREATE POLICY users_admin_delete ON users FOR DELETE USING (is_admin());
