-- example table to prove the stack works
CREATE TABLE IF NOT EXISTS things (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
