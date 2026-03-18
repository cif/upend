-- upend framework tables — created automatically, not user-managed

-- internal schema (hidden from Data API)
CREATE SCHEMA IF NOT EXISTS upend;

-- migration tracking (public, but prefixed with _ so Data API ignores it)
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT now()
);

-- oauth state tracking — internal
CREATE TABLE IF NOT EXISTS upend.oauth_states (
  id SERIAL PRIMARY KEY,
  state TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- claude editing sessions — internal
CREATE TABLE IF NOT EXISTS upend.editing_sessions (
  id BIGSERIAL PRIMARY KEY,
  prompt TEXT NOT NULL,
  title TEXT,
  status TEXT DEFAULT 'active',
  claude_session_id TEXT,
  snapshot_name TEXT,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- session messages — internal
CREATE TABLE IF NOT EXISTS upend.session_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES upend.editing_sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  result TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);
