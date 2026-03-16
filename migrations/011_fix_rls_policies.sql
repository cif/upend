-- Recreate RLS policies using Neon's auth.user_id() function
-- (old policies were dropped with CASCADE when we dropped the auth schema)

CREATE POLICY things_owner_select ON things FOR SELECT USING (owner_id = auth.user_id());
CREATE POLICY things_owner_insert ON things FOR INSERT WITH CHECK (owner_id = auth.user_id());
CREATE POLICY things_owner_update ON things FOR UPDATE USING (owner_id = auth.user_id());
CREATE POLICY things_owner_delete ON things FOR DELETE USING (owner_id = auth.user_id());
