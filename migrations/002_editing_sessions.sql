CREATE TABLE IF NOT EXISTS editing_sessions (
  id BIGSERIAL PRIMARY KEY,
  prompt TEXT NOT NULL,
  context JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_edits (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES editing_sessions(id),
  file_path TEXT NOT NULL,
  diff TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);
