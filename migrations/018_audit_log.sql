-- append-only audit log
-- protected by RLS: insert only, no update/delete policies

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now() NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail JSONB DEFAULT '{}',
  ip TEXT
);

-- RLS: append-only enforcement
ALTER TABLE audit.log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.log FORCE ROW LEVEL SECURITY;

-- anyone can insert
CREATE POLICY "append_only" ON audit.log FOR INSERT WITH CHECK (true);

-- anyone can read (for dashboard display)
CREATE POLICY "read_all" ON audit.log FOR SELECT USING (true);

-- no UPDATE or DELETE policies = denied by RLS
-- even the table owner is blocked by FORCE ROW LEVEL SECURITY
