CREATE TABLE reps (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE accounts (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  website text,
  industry text,
  rep_id bigint REFERENCES reps(id) ON DELETE SET NULL,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE contacts (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  first_name text NOT NULL,
  last_name text,
  email text,
  phone text,
  title text,
  account_id bigint REFERENCES accounts(id) ON DELETE SET NULL,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reps: authenticated read" ON reps
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "reps: owner write" ON reps
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "accounts: owner all" ON accounts
  FOR ALL TO authenticated
  USING (owner_id = auth.user_id())
  WITH CHECK (owner_id = auth.user_id());

CREATE POLICY "contacts: owner all" ON contacts
  FOR ALL TO authenticated
  USING (owner_id = auth.user_id())
  WITH CHECK (owner_id = auth.user_id());

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON reps TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE reps_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE accounts_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE contacts_id_seq TO authenticated;
