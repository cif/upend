-- Move upend internal tables to their own schema
-- Only public schema tables get exposed via Neon Data API / PostgREST
-- _migrations stays in public so the migration runner always finds it

CREATE SCHEMA IF NOT EXISTS upend;

-- move internal tables to upend schema
ALTER TABLE IF EXISTS public.editing_sessions SET SCHEMA upend;
ALTER TABLE IF EXISTS public.session_messages SET SCHEMA upend;
ALTER TABLE IF EXISTS public.oauth_states SET SCHEMA upend;

-- grant access to the internal schema
GRANT USAGE ON SCHEMA upend TO neondb_owner;
GRANT ALL ON ALL TABLES IN SCHEMA upend TO neondb_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA upend TO neondb_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA upend GRANT ALL ON TABLES TO neondb_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA upend GRANT ALL ON SEQUENCES TO neondb_owner;

-- update search_path to include upend schema
ALTER ROLE neondb_owner SET search_path TO public, auth, upend;
