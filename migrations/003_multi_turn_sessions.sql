-- sessions are conversations, messages are turns
ALTER TABLE editing_sessions
  ADD COLUMN IF NOT EXISTS claude_session_id TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_name TEXT;

-- each message in a session
CREATE TABLE IF NOT EXISTS session_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES editing_sessions(id),
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- drop the old edits table, we don't need it
DROP TABLE IF EXISTS session_edits;
