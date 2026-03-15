# upend

You have FULL control of this codebase. Edit anything. Run anything. Create migrations. Restart services. You are the developer.

This is a live system. Changes you make take effect immediately (Bun --watch). There is no git workflow, no PR process, no CI/CD. You edit files, they go live. A snapshot was taken before you started — if something breaks, the user can rollback.

## What you can do
- Edit any file in the project
- Create new files, services, migrations
- Run `bun src/migrate.ts` to apply database migrations
- Run any bash command
- Create apps in `apps/` that are instantly served by Caddy
- Modify the API, add endpoints, change auth rules
- You have access to the database via `lib/db.ts` exports
- Query the database to inspect schemas, tables, columns, RLS policies
- Build frontend apps that talk to the Neon Data API

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
- **Env**: dotenvx (encrypted .env, Bun auto-loads it via dotenvx)
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

## Data API (Neon PostgREST)
User-facing data access goes through Neon's Data API, available at the `NEON_DATA_API` env var.

The Data API URL is: `process.env.NEON_DATA_API` (PostgREST)

It auto-generates REST endpoints for every table in the `public` schema:
- `GET /<table>` — list rows (supports ?select=, ?order=, ?limit=, filters)
- `GET /<table>?id=eq.5` — filter rows
- `POST /<table>` — insert (JSON body, returns row with Prefer: return=representation)
- `PATCH /<table>?id=eq.5` — update matching rows
- `DELETE /<table>?id=eq.5` — delete matching rows
- `GET /` — OpenAPI spec (auto-generated from schema)

PostgREST filter operators: eq, neq, gt, gte, lt, lte, like, ilike, is, in, not
Example: `GET /things?name=ilike.*widget*&order=created_at.desc&limit=10`

All requests need: `Authorization: Bearer <jwt>` and `apikey: <anon-key>` headers.
The JWT comes from our auth endpoints. RLS policies enforce row-level access.

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

## Conventions
- No git workflows. Edit, save, it's live.
- Migrations are plain SQL. Number them sequentially. Run with `bun src/migrate.ts`.
- New services: create `services/<name>/index.ts`, add to `infra/services.json`
- New apps: write files to `apps/<name>/`, instantly served at `/apps/<name>/`
- Match the upend aesthetic: dark bg (#0a0a0a), orange accent (#f97316), monospace fonts
