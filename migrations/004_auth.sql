-- auth schema + user_id function (used by RLS policies)
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.user_id() RETURNS TEXT AS $$
  SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')
$$ LANGUAGE sql STABLE;

-- users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- add owner_id to things for RLS
ALTER TABLE things ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id);

-- enable RLS on things
ALTER TABLE things ENABLE ROW LEVEL SECURITY;

CREATE POLICY things_owner_select ON things FOR SELECT USING (owner_id = auth.user_id());
CREATE POLICY things_owner_insert ON things FOR INSERT WITH CHECK (owner_id = auth.user_id());
CREATE POLICY things_owner_update ON things FOR UPDATE USING (owner_id = auth.user_id());
CREATE POLICY things_owner_delete ON things FOR DELETE USING (owner_id = auth.user_id());

-- restricted role for authenticated queries (no BYPASSRLS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.user_id() TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO authenticated;
