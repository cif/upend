# upend

Anti-SaaS stack. No git workflows. No CI/CD. Deploy via rsync. Edit live. One backup.

Bun + Hono + Neon Postgres. Custom JWT auth. Claude editing sessions with file + database snapshots. Hot-deployed frontend apps from the filesystem.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- [Caddy](https://caddyserver.com) (`brew install caddy`)
- [Claude Code](https://claude.ai/code) (`npm i -g @anthropic-ai/claude-code`)
- A [Neon](https://neon.tech) database (free tier works)

## Setup

```bash
bun install

# configure your env
cp .env.example .env
# paste your Neon DATABASE_URL into .env

# encrypt it (only needs to happen once, then after any .env changes)
npx dotenvx encrypt

# run migrations
bun run migrate

# start everything
bun run dev
```

This starts:
- **API** on `:3001`
- **Claude service** on `:3002`
- **Caddy** reverse proxy on `:4000`

Everything is accessible through Caddy at `http://localhost:4000`:

| URL | What |
|-----|------|
| `/api/auth/signup` | Create account (POST `{email, password}`) |
| `/api/auth/login` | Login (POST `{email, password}` → `{user, token}`) |
| `/api/data/:table` | CRUD any table (GET/POST/PATCH/DELETE, requires auth) |
| `/api/stream/logs` | SSE log stream |
| `/.well-known/jwks.json` | Public keys for JWT verification |
| `/claude/ui/` | Chat UI for Claude editing sessions |
| `/claude/sessions` | Session management API |
| `/claude/apps` | App management API |
| `/apps/:name/` | Live apps served from filesystem |

## Working with the API

Sign up and get a token:

```bash
curl -X POST localhost:4000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"yourpassword"}'
# → { user: {...}, token: "eyJ..." }
```

Use the token for authenticated requests:

```bash
TOKEN="eyJ..."

# create
curl -X POST localhost:4000/api/data/things \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my thing","data":{"foo":"bar"},"owner_id":"YOUR_USER_ID"}'

# list
curl localhost:4000/api/data/things \
  -H "Authorization: Bearer $TOKEN"

# update
curl -X PATCH localhost:4000/api/data/things/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"updated"}'

# delete
curl -X DELETE localhost:4000/api/data/things/1 \
  -H "Authorization: Bearer $TOKEN"
```

RLS policies enforce that users can only see their own rows (via `owner_id`).

## Making changes with Claude

### Chat UI

Open `http://localhost:4000/claude/ui/` in your browser. Log in, then tell Claude what to do. It has full access to the codebase — edits go live (Bun's `--watch` picks up changes automatically).

Before Claude touches anything, the system snapshots all files + the database. If things go sideways, hit the rollback button.

### API changes

Tell Claude things like:
- "add a `projects` table with name, description, and status columns"
- "add rate limiting to the API"
- "add a webhook endpoint that posts to Slack"

Claude will create migrations, edit route files, whatever it needs. Changes to the API are picked up by `--watch` automatically.

### Via curl

```bash
# start a session
curl -X POST localhost:4000/claude/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"add a projects table and CRUD endpoints for it"}'

# continue the conversation
curl -X POST localhost:4000/claude/sessions/1/messages \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"also add an owner_id column with RLS"}'

# watch it work
curl localhost:4000/claude/sessions/1/stream
```

## Hot-deployed frontend apps

Apps are just files in the `apps/` directory, served directly by Caddy. No build step, no restart. Drop files in, they're live.

### Generate an app with Claude

```bash
curl -X POST localhost:4000/claude/apps/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "dashboard",
    "prompt": "build a dashboard that lists all things from the API with create/edit/delete. dark theme, clean UI."
  }'
# → generating... live at /apps/dashboard/ when done
```

Or tell Claude in the chat UI: *"create an app called dashboard in apps/dashboard that shows all things from the API"*

### Create an app from raw files

```bash
curl -X POST localhost:4000/claude/apps \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "hello",
    "files": {
      "index.html": "<!DOCTYPE html><html><body><h1>hello</h1></body></html>"
    }
  }'
# → instantly live at /apps/hello/
```

### App conventions

Apps are static HTML/JS/CSS. They can call the API at `/api/` (same origin, no CORS issues). Auth tokens are stored in `localStorage` as `upend_token`. Include the token in requests:

```js
const token = localStorage.getItem('upend_token');
const res = await fetch('/api/data/things', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const things = await res.json();
```

### List apps

```bash
curl localhost:4000/claude/apps
# → [{ name: "dashboard", url: "/apps/dashboard/", created: "..." }]
```

## Database migrations

Plain SQL files in `migrations/`, numbered `001_name.sql`. Run them:

```bash
bun run migrate
```

Or tell Claude: *"create a migration for a projects table"* — it'll create the SQL file and run it.

## Project structure

```
upend/
├── services/
│   ├── api/              → :3001 — auth, CRUD, SSE logs
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── auth-routes.ts
│   └── claude/           → :3002 — editing sessions, app generator
│       ├── index.ts
│       ├── snapshots.ts
│       └── public/       → chat UI
├── apps/                 → hot-deployed frontends (served by Caddy)
├── lib/
│   ├── db.ts             → postgres.js connection
│   ├── auth.ts           → JWT signing/verification, JWKS
│   └── middleware.ts     → auth middleware
├── migrations/           → plain SQL, numbered
├── infra/
│   ├── Caddyfile         → production reverse proxy
│   ├── Caddyfile.dev     → local reverse proxy (:4000)
│   ├── services.json     → service registry
│   ├── upend@.service    → systemd template
│   └── setup.sh          → one-time EC2 setup
├── .keys/                → RSA keys for JWT (gitignored)
├── .snapshots/           → file + db snapshots (gitignored)
├── .env                  → encrypted by dotenvx (safe to commit)
├── .env.keys             → decryption keys (gitignored, NEVER commit)
├── index.ts              → entry point: starts all services + caddy
├── deploy.sh             → rsync deploy to EC2
└── new-service.sh        → scaffold a new service
```

## Adding a new service

```bash
./new-service.sh webhooks 3003
# creates services/webhooks/index.ts, registers in services.json, adds Caddy route
```

## Snapshots and rollback

Every Claude editing session snapshots files + database before making changes. To rollback:

```bash
# list snapshots
curl localhost:4000/claude/snapshots

# rollback (restores files AND database)
curl -X POST localhost:4000/claude/rollback \
  -H 'Content-Type: application/json' \
  -d '{"snapshot":"snap-2026-03-15T05-06-46-393Z"}'
```

A safety snapshot is taken before every rollback, so you can undo the undo.

## SSO / OAuth

Built-in support for Google, GitHub, and Microsoft. Or any OIDC provider. Add env vars:

```bash
# Google
OAUTH_GOOGLE_CLIENT_ID=xxx
OAUTH_GOOGLE_CLIENT_SECRET=xxx

# Any OIDC provider
OAUTH_CORPNAME_CLIENT_ID=xxx
OAUTH_CORPNAME_CLIENT_SECRET=xxx
OAUTH_CORPNAME_AUTHORIZE_URL=https://sso.corp.com/authorize
OAUTH_CORPNAME_TOKEN_URL=https://sso.corp.com/token
OAUTH_CORPNAME_USERINFO_URL=https://sso.corp.com/userinfo
```

Then `GET /api/auth/sso/google` (or `/api/auth/sso/corpname`) kicks off the OAuth flow.

## Deploy to EC2

```bash
# set your deploy target
export DEPLOY_HOST=ec2-user@your-instance-ip

# first time: SSH in and run setup
ssh $DEPLOY_HOST 'bash -s' < infra/setup.sh

# deploy (rsync → install → migrate → restart)
./deploy.sh

# deploy a single service
./deploy.sh api
```

## Scripts

| Command | What |
|---------|------|
| `bun run dev` | Start all services + Caddy locally |
| `bun run dev:api` | Start just the API service |
| `bun run dev:claude` | Start just the Claude service |
| `bun run migrate` | Run database migrations |
| `bun run deploy` | Deploy to remote host |
| `bun run new-service <name>` | Scaffold a new service |
