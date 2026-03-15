-- Fix search_path for Neon pooler connections
ALTER ROLE neondb_owner SET search_path TO public, auth;
