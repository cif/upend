# Data API & Row-Level Security (RLS)

## How the data API works

All user-facing data goes through `/api/data/:table` endpoints (GET, POST, PATCH, DELETE). These are PostgREST-style with filter operators like `?field=eq.value`, `?order=created_at.desc`, `?limit=10`.

Every request runs inside `withRLS()` which:
1. Drops the connection role to `authenticated` (the default connection is `neondb_owner` which has `BYPASSRLS` and would skip all policies)
2. Sets session variables from the JWT so RLS policies can identify the user
3. Runs the query — policies are enforced by Postgres

```ts
// services/api/index.ts
async function withRLS(user, fn) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'authenticated'`);
    await tx.unsafe(`SET LOCAL request.jwt.sub = '${user.sub}'`);
    await tx.unsafe(`SET LOCAL request.jwt.role = '${user.role}'`);
    await tx.unsafe(`SET LOCAL request.jwt.email = '${user.email}'`);
    await tx.unsafe(`SET LOCAL request.jwt.app_role = '${user.app_role || user.role}'`);
    return fn(tx);
  });
}
```

## RLS helper functions

Three SQL functions simplify writing policies. They read from the session variables set by `withRLS`:

| Function | Returns | Description |
|----------|---------|-------------|
| `current_user_id()` | `text` | The authenticated user's ID (`request.jwt.sub`) |
| `current_user_role()` | `text` | The user's app role: `'admin'` or `'user'` (`request.jwt.app_role`) |
| `is_admin()` | `boolean` | Shorthand for `current_user_role() = 'admin'` |

These are defined in `migrations/023_rls_helpers.sql`.

## Writing RLS policies

### Step 1: Enable RLS on the table

```sql
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE my_table FORCE ROW LEVEL SECURITY;
```

Both lines are required:
- `ENABLE` turns on RLS
- `FORCE` ensures it applies even for the table owner role (`neondb_owner` has `BYPASSRLS`)

### Step 2: Create policies using the helpers

Common patterns:

**Owner-only access:**
```sql
CREATE POLICY my_table_owner ON my_table FOR ALL USING (
  owner_id = current_user_id()
);
```

**Owner + admin access:**
```sql
CREATE POLICY my_table_select ON my_table FOR SELECT USING (
  owner_id = current_user_id() OR is_admin()
);
```

**Public read, owner write:**
```sql
CREATE POLICY my_table_read ON my_table FOR SELECT USING (true);
CREATE POLICY my_table_write ON my_table FOR ALL USING (
  owner_id = current_user_id() OR is_admin()
);
```

**Admin-only write:**
```sql
CREATE POLICY my_table_read ON my_table FOR SELECT USING (true);
CREATE POLICY my_table_admin_write ON my_table FOR INSERT WITH CHECK (is_admin());
CREATE POLICY my_table_admin_update ON my_table FOR UPDATE USING (is_admin());
CREATE POLICY my_table_admin_delete ON my_table FOR DELETE USING (is_admin());
```

### Step 3: Create a migration

See [Migrations](#migrations) below.

## Migrations

Plain SQL files in `migrations/`, numbered sequentially: `001_create_users.sql`, `002_add_things.sql`, etc. No ORM, no migration framework — just SQL.

```sql
-- migrations/024_add_products.sql
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price numeric,
  owner_id text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY products_owner ON products FOR ALL USING (
  owner_id = current_user_id() OR is_admin()
);
```

Run with:
```bash
bun src/migrate.ts
```

The migrate script tracks which files have already run (in a `_migrations` table) and applies new ones in order. It's idempotent — safe to run repeatedly.

When working on the instance, create the file and run it immediately. Changes take effect right away.

## Important notes

- **Do NOT use `auth.user_id()` or `auth.jwt()`** — these are Neon's built-in C functions that require `pg_session_jwt` JWK configuration we don't use. They return null.
- **Always use `current_user_id()`, `current_user_role()`, and `is_admin()`** — these read from the session variables that `withRLS` sets.
- **Always include `FORCE ROW LEVEL SECURITY`** — without it, the `neondb_owner` role bypasses all policies.
- **Tables with `owner_id`** should have it set on insert. The convention is: apps set `owner_id` from the JWT sub claim, or services set it server-side.
- **NULL `owner_id`** won't match `current_user_id()` — rows with null owner are only visible to admins (unless you add an explicit null check).

## Current policies

| Table | Policy | Rule |
|-------|--------|------|
| `things` | select, update, delete | owner or admin |
| `things` | insert | anyone (authenticated) |
| `accounts` | all | owner only |
| `contacts` | all | owner only |
| `users` | select | everyone |
| `users` | update | own row or admin |
| `users` | insert, delete | admin only |
| `roles` | select | everyone |
| `roles` | insert, update, delete | admin only |
| `reps` | all | everyone (no restrictions) |
| `goodbyes` | — | RLS not enabled |

## Testing RLS

You can test policies directly:

```ts
import { sql } from "./lib/db";

const rows = await sql.begin(async (tx) => {
  await tx.unsafe(`SET LOCAL role = 'authenticated'`);
  await tx.unsafe(`SET LOCAL request.jwt.sub = 'some-user-id'`);
  await tx.unsafe(`SET LOCAL request.jwt.app_role = 'user'`);
  return tx`SELECT * FROM things`;
});
// → only rows owned by 'some-user-id'
```
