-- roles table for managing user roles with descriptions and permissions
CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY,
  description TEXT,
  permissions JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- seed default roles
INSERT INTO roles (name, description, permissions) VALUES
  ('admin', 'Full system access. Can manage users, roles, impersonate, and access all data.', '{"admin": true}'),
  ('user', 'Standard user. Access governed by RLS policies.', '{}')
ON CONFLICT (name) DO NOTHING;

-- add foreign key from users.role to roles.name
ALTER TABLE users
  ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(name);

-- RLS on roles table: everyone can read, only admins can modify
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_read ON roles FOR SELECT USING (true);
CREATE POLICY roles_admin_insert ON roles FOR INSERT
  WITH CHECK (current_setting('request.jwt.role', true) = 'admin');
CREATE POLICY roles_admin_update ON roles FOR UPDATE
  USING (current_setting('request.jwt.role', true) = 'admin');
CREATE POLICY roles_admin_delete ON roles FOR DELETE
  USING (current_setting('request.jwt.role', true) = 'admin');

-- grant access to authenticated role
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO authenticated;
