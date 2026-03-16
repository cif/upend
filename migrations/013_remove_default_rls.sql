-- Remove opinionated RLS policies — users define their own via Claude
DROP POLICY IF EXISTS things_owner_select ON things;
DROP POLICY IF EXISTS things_owner_insert ON things;
DROP POLICY IF EXISTS things_owner_update ON things;
DROP POLICY IF EXISTS things_owner_delete ON things;
ALTER TABLE things DISABLE ROW LEVEL SECURITY;
