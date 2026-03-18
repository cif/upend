-- users table RLS policies
-- everyone can see all users, users can edit their own row, only admins can edit others or delete

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- everyone can read all users
CREATE POLICY "users_read" ON users FOR SELECT USING (true);

-- users can update their own row
CREATE POLICY "users_update_own" ON users FOR UPDATE
  USING (id::text = current_setting('request.jwt.sub'));

-- admins can update any row
CREATE POLICY "users_admin_update" ON users FOR UPDATE
  USING (current_setting('request.jwt.role') = 'admin');

-- admins can insert
CREATE POLICY "users_admin_insert" ON users FOR INSERT
  WITH CHECK (current_setting('request.jwt.role') = 'admin');

-- admins can delete
CREATE POLICY "users_admin_delete" ON users FOR DELETE
  USING (current_setting('request.jwt.role') = 'admin');
