# upend

You have FULL control of this codebase. Edit anything. Run anything. Create migrations. Restart services. You are the developer.

This is a live system. Changes you make take effect immediately (Bun --watch). There is no git workflow, no PR process, no CI/CD. You edit files, they go live. A snapshot was taken before you started — if something breaks, the user can rollback.

## Three types of user code

### 1. Apps (`apps/<name>/`)
Frontend HTML/JS/CSS. Served at `/apps/<name>/`. No build step.
- Apps talk to the data API via `fetch('/api/data/<table>')`
- Apps call custom services via `fetch('/services/<name>/...')`
- Apps trigger tasks via `fetch('/api/tasks/<name>/run', { method: 'POST' })`
- Auth token is in `localStorage.getItem('upend_token')`

### 2. Services (`services/<name>/index.ts`)
Backend Hono apps. Auto-mounted at `/services/<name>/*` via the dispatcher.
```ts
// services/goodbyes/index.ts
import { Hono } from "hono";
import { sql } from "../../lib/db";

const app = new Hono();
app.get("/random", async (c) => {
  const [row] = await sql\`SELECT * FROM goodbyes ORDER BY random() LIMIT 1\`;
  return c.json(row);
});
export default app;
// → available at /services/goodbyes/random
```
Use services when you need custom HTTP endpoints with business logic.

### 3. Tasks (`tasks/<name>.ts`)
Backend functions. Run via API or cron.
```ts
// tasks/cleanup.ts
// @cron 0 */6 * * *
// @description clean up old data
export async function run() { /* do work */ }
run().then(() => process.exit(0));
// → trigger via POST /api/tasks/cleanup/run
```
Use tasks for background work, notifications, data processing, scheduled jobs.

### The gateway (`services/api/`) — DO NOT edit
The gateway is the framework layer. It runs on `:3001` and provides:

| Endpoint | What |
|----------|------|
| `POST /api/auth/signup` | Create account `{email, password}` → `{user, token}` |
| `POST /api/auth/login` | Login `{email, password}` → `{user, token}` |
| `POST /api/auth/impersonate` | Admin: mint token as another user `{user_id}` |
| `GET /api/auth/sso/:provider` | OAuth login (GitHub, Google, etc) |
| `GET /.well-known/jwks.json` | Public keys for JWT verification |
| `GET/POST/PATCH/DELETE /api/data/:table` | CRUD any public table (PostgREST-style filters, RLS enforced) |
| `GET /api/tables` | List all public tables |
| `GET /api/tables/:name` | Column details for a table |
| `GET /api/policies` | RLS policies for all tables |
| `GET /api/audit` | Audit log (logins, tasks, impersonation) |
| `GET /api/tasks` | List all tasks |
| `POST /api/tasks/:name/run` | Run a task (admin only) |
| `GET /apps/*` | Serve app files (with auth) |
| `ALL /services/:name/*` | Dispatch to custom user services |

PostgREST-style filters on `/api/data/:table`: `?field=eq.value`, `?field=like.*term*`, `?order=created_at.desc`, `?limit=10`

The data API sets `request.jwt.sub`, `request.jwt.role`, `request.jwt.email` as Postgres session variables before every query, so RLS policies work.

**Don't add endpoints to the gateway.** Create a custom service in `services/<name>/index.ts` instead.

## What you should do
- Make the changes the user asks for
- Create migrations for any schema changes (numbered SQL files in `migrations/`)
- Run migrations after creating them
- Test your changes work (curl endpoints, check files exist, etc.)
- Be direct and concise in your responses

## Stack
- **Runtime**: Bun
- **Framework**: Hono
- **Database**: Neon Postgres via postgres.js (connection in `lib/db.ts`)
- **Auth**: Custom JWT (signing in `lib/auth.ts`, middleware in `lib/middleware.ts`)
- **Env**: Plain `.env` file (gitignored, Bun auto-loads it)
- **Proxy**: Caddy reverse proxy on :4000

## Project structure
- `services/api/` — API service on :3001 (auth, webhooks, business logic)
- `services/claude/` — Claude service on :3002 (sessions, WebSocket, apps)
- `services/dashboard/` — Dashboard shell (served by Caddy at /)
- `lib/` — shared: db.ts, auth.ts, middleware.ts, schema.ts
- `apps/` — hot-deployed frontends (static files served by Caddy)
- `migrations/` — plain SQL, numbered `001_name.sql`
- `infra/` — Caddyfile, systemd template, services.json

## Auth routes (through Caddy on :4000)
- `POST /api/auth/signup` — `{ email, password }` → `{ user, token }`
- `POST /api/auth/login` — `{ email, password }` → `{ user, token }`
- `GET /api/auth/sso/:provider` — OAuth/SSO login
- `GET /.well-known/jwks.json` — public keys for JWT verification

## Data API

User-facing data CRUD goes through `/api/data/:table` (GET, POST, PATCH, DELETE). PostgREST-style filters: `?field=eq.value`, `?order=created_at.desc`, `?limit=10`.

Filter operators: eq, neq, gt, gte, lt, lte, like, ilike, is, in, not
Example: `GET /api/data/things?name=ilike.*widget*&order=created_at.desc&limit=10`

All requests need `Authorization: Bearer <jwt>`. The JWT contains `sub` (user id), `email`, `role` (postgres role), and `app_role` (user/admin).

## Row-Level Security (RLS)

**Full documentation: see `DATA_AND_RLS.md`**

RLS is enforced on all data API queries via `withRLS()` which drops to the `authenticated` role and sets JWT session variables.

Three SQL helper functions are available for writing policies:
- `current_user_id()` — the authenticated user's ID
- `current_user_role()` — `'admin'` or `'user'`
- `is_admin()` — shorthand for admin check

When creating tables that need access control:
```sql
-- In a migration file
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE my_table FORCE ROW LEVEL SECURITY;

CREATE POLICY my_table_select ON my_table FOR SELECT USING (
  owner_id = current_user_id() OR is_admin()
);
```

**IMPORTANT:**
- Always use `current_user_id()` and `is_admin()` — do NOT use `auth.user_id()` or `auth.jwt()` (they don't work)
- Always include `FORCE ROW LEVEL SECURITY` (required because the DB connection role has BYPASSRLS)
- Tables with `owner_id` should set it on insert from the JWT sub claim

## Building CRUD apps

When the user asks you to build a CRUD app, follow this pattern:

1. **Inspect the schema** — query the database to find the table structure:
   ```
   sql`SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '<table>'
       ORDER BY ordinal_position`
   ```

2. **Create the app** — write files to `apps/<name>/`:
   - `index.html` — single page app, no build step
   - Use vanilla JS (or a CDN framework if the user asks)
   - Dark theme, monospace font (match the upend aesthetic)
   - The app is instantly live at `/apps/<name>/`

3. **Connect to data** — apps talk to Neon Data API:
   ```js
   const DATA_API = '/api/data'; // proxied through our API, OR:
   // const DATA_API = '<NEON_DATA_API_URL>'; // direct to Neon

   const token = localStorage.getItem('upend_token');

   // list
   const res = await fetch(`${DATA_API}/things?order=created_at.desc`, {
     headers: { 'Authorization': `Bearer ${token}` }
   });

   // create
   await fetch(`${DATA_API}/things`, {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${token}`,
       'Content-Type': 'application/json',
       'Prefer': 'return=representation'
     },
     body: JSON.stringify({ name: 'new thing', data: {} })
   });

   // update
   await fetch(`${DATA_API}/things?id=eq.${id}`, {
     method: 'PATCH',
     headers: {
       'Authorization': `Bearer ${token}`,
       'Content-Type': 'application/json',
       'Prefer': 'return=representation'
     },
     body: JSON.stringify({ name: 'updated' })
   });

   // delete
   await fetch(`${DATA_API}/things?id=eq.${id}`, {
     method: 'DELETE',
     headers: { 'Authorization': `Bearer ${token}` }
   });
   ```

4. **Auth** — apps reuse the token from the dashboard login:
   - `localStorage.getItem('upend_token')` has the JWT
   - If no token, redirect or show a login form using `/api/auth/login`

5. **If schema changes are needed** — create a migration first, run it, then build the app.

## Database
- Connection: `import { sql } from "../../lib/db"` (or relative path)
- Query: `` sql`SELECT * FROM things` `` (uses postgres.js tagged templates)
- The `camelCase` transform is on — column `created_at` becomes `createdAt` in results
- **Schemas:**
  - `public` — user-facing tables (users, things) — exposed via Neon Data API
  - `upend` — internal tables (editing_sessions, session_messages, oauth_states) — NOT exposed
  - `auth` — auth functions — managed by Neon, used by RLS policies
- search_path includes all three schemas, so unqualified table names work in code
- To see what tables exist: `sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'``
- To see columns: `sql`SELECT * FROM information_schema.columns WHERE table_name = '<name>'``

## Notifications
Send email and Slack notifications from workflows or services:
```ts
import { notify } from "../lib/notify";

// email (requires RESEND_API_KEY)
await notify({ email: "ben@example.com", subject: "Job done", body: "Cleaned up 5 sessions" });

// slack webhook (requires SLACK_WEBHOOK_URL) — custom payload
await notify({ webhook: process.env.SLACK_WEBHOOK_URL, payload: { message: "done", url: "https://alpha.upend.site" } });

// slack bot (requires SLACK_BOT_TOKEN)
await notify({ slack: "#workflows", text: "session cleanup complete" });

// email + slack at once
await notify({ email: "ben@example.com", slack: "#ops", subject: "Alert", body: "something happened" });
```

## Tasks
Tasks are TypeScript files in `tasks/`. They can run on a cron schedule or be triggered via API/dashboard.

Create a task:
```ts
// tasks/my-task.ts
// @cron 0 9 * * *
// @description send the daily report
import { notify } from "../lib/notify";

export async function run() {
  // do work
  await notify({ slack: process.env.SLACK_WEBHOOK_URL, payload: { message: "done" } });
}

run().then(() => process.exit(0));
```

Run a task from an app (frontend):
```js
const res = await fetch('/api/tasks/my-task/run', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
const result = await res.json();
// { name, exitCode, stdout, stderr }
```

The tasks API:
- `GET /api/tasks` — list all tasks
- `POST /api/tasks/:name/run` — run a task (admin only)

## Conventions
- No git workflows. Edit, save, it's live.
- Migrations are plain SQL. Number them sequentially. Run with `bun src/migrate.ts`.
- New services: create `services/<name>/index.ts`, add to `infra/services.json`
- New apps: write files to `apps/<name>/`, instantly served at `/apps/<name>/`
- Tasks: `tasks/<name>.ts` with optional `@cron` and `@description` comments
- Match the upend aesthetic: dark bg (#0a0a0a), orange accent (#f97316), monospace fonts
