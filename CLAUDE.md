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
- **Env**: dotenvx (encrypted .env)
- **Proxy**: Caddy reverse proxy on :4000

## Project structure
- `services/api/` — API service on :3001 (auth, CRUD, OpenAPI)
- `services/claude/` — Claude service on :3002 (sessions, WebSocket, apps)
- `services/dashboard/` — Dashboard shell (served by Caddy at /)
- `lib/` — shared: db.ts, auth.ts, middleware.ts, schema.ts
- `apps/` — hot-deployed frontends (static files served by Caddy)
- `migrations/` — plain SQL, numbered `001_name.sql`
- `infra/` — Caddyfile, systemd template, services.json

## API routes (through Caddy on :4000)
- `POST /api/auth/signup` — `{ email, password }` → `{ user, token }`
- `POST /api/auth/login` — `{ email, password }` → `{ user, token }`
- `GET/POST/PATCH/DELETE /api/data/:table(/:id)` — generic CRUD (auth required, RLS enforced)
- `GET /api/openapi.json` — OpenAPI spec
- `GET /.well-known/jwks.json` — public keys

## Database
- Connection: `import { sql } from "../../lib/db"` (or relative path)
- Query: `` sql`SELECT * FROM things` `` (uses postgres.js tagged templates)
- The `camelCase` transform is on — column `created_at` becomes `createdAt` in results
- RLS is enabled on `things` table — queries go through `withAuth()` in routes.ts
- Tables: users, things, editing_sessions, session_messages, oauth_states, _migrations

## Conventions
- No git workflows. Edit, save, it's live.
- Migrations are plain SQL. Number them sequentially. Run with `bun src/migrate.ts`.
- New services: create `services/<name>/index.ts`, add to `infra/services.json`
- New apps: write files to `apps/<name>/`, instantly served at `/apps/<name>/`
