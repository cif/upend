# upend

Anti-SaaS stack. Your code, your server, your database. Deploy via rsync. Edit live with Claude.

Bun + Hono + Neon Postgres + Caddy. Custom JWT auth. Claude editing sessions with git worktree isolation. Hot-deployed frontend apps.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Caddy](https://caddyserver.com) — `brew install caddy`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
- A [Neon](https://neon.tech) account (free tier works)
- Optionally: [neonctl](https://neon.tech/docs/reference/neon-cli) — `npm i -g neonctl` (automates DB setup)

## Quickstart

```bash
# create a new project
bunx @upend/cli init my-project

# follow the prompts — if neonctl is installed, it will:
#   1. create a Neon database
#   2. enable the Data API (PostgREST)
#   3. configure JWKS for JWT auth
#   4. generate RSA signing keys
#   5. encrypt your .env with dotenvx

cd my-project

# add your Anthropic API key
# (edit .env, then re-encrypt)
vi .env
bunx @dotenvx/dotenvx encrypt

# run migrations
bunx upend migrate

# start dev
bunx upend dev
```

Open http://localhost:4000 — you'll see the dashboard.

## What you get

```
my-project/
├── apps/                 → hot-deployed frontends (drop files in, they're live)
├── migrations/
│   └── 001_init.sql      → starter migration
├── services/             → custom Hono services (optional)
├── upend.config.ts       → project config
├── CLAUDE.md             → instructions for Claude editing sessions
├── .env                  → encrypted credentials (safe to commit)
├── .env.keys             → decryption keys (gitignored)
├── .keys/                → JWT signing keys (gitignored)
└── package.json
```

## URLs

Everything runs through Caddy at `:4000`:

| URL | What |
|-----|------|
| `http://localhost:4000` | Dashboard — chat with Claude, browse data, manage apps |
| `/api/auth/signup` | Create account — `POST {email, password}` → `{user, token}` |
| `/api/auth/login` | Login — `POST {email, password}` → `{user, token}` |
| `/.well-known/jwks.json` | Public keys for JWT verification |
| `/apps/<name>/` | Your apps, served from the filesystem |

## Auth

Sign up:

```bash
curl -X POST http://localhost:4000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"yourpassword"}'
# → { user: { id, email }, token: "eyJ..." }
```

Use the token everywhere:

```bash
TOKEN="eyJ..."
curl http://localhost:4000/api/data/example \
  -H "Authorization: Bearer $TOKEN"
```

## Data API

Your tables are automatically available as REST endpoints via Neon's Data API:

```bash
# list rows
curl /api/data/example?order=created_at.desc \
  -H "Authorization: Bearer $TOKEN"

# create
curl -X POST /api/data/example \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d '{"name":"hello","data":{"key":"value"}}'

# update
curl -X PATCH '/api/data/example?id=eq.5' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"updated"}'

# delete
curl -X DELETE '/api/data/example?id=eq.5' \
  -H "Authorization: Bearer $TOKEN"
```

PostgREST filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`.

## Migrations

Plain SQL files in `migrations/`, numbered sequentially:

```bash
# create a migration
cat > migrations/002_projects.sql << 'SQL'
CREATE TABLE projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
SQL

# run it
bunx upend migrate
```

Or tell Claude in the dashboard: *"add a projects table with name and owner"* — it'll create the migration and run it.

## Apps

Apps are static files in `apps/<name>/`. No build step. Drop files in, they're instantly live at `/apps/<name>/`.

From the dashboard, tell Claude: *"build a todo app"* — it creates the files in a git worktree, you preview them, then publish to live.

Apps can call the API at the same origin:

```js
const token = localStorage.getItem('upend_token');
const res = await fetch('/api/data/projects?order=created_at.desc', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const projects = await res.json();
```

## Editing with Claude

The dashboard at `/` has a built-in chat. Each conversation creates an isolated git worktree — Claude edits files there, you preview the changes, then click **Publish** to merge into live.

If something breaks, close the session without publishing. Your live code is untouched.

## Deploy

### Provision infrastructure

```bash
# provision an EC2 instance (t4g.small, Amazon Linux 2023)
bunx upend infra:aws

# this creates:
#   - EC2 instance with Bun, Node, Caddy, Claude Code
#   - security group (ports 22, 80, 443)
#   - SSH key pair
#   - SSH config entry: "ssh upend"
```

### Deploy your code

```bash
# set your deploy target in .env
DEPLOY_HOST=ec2-user@<ip>

# deploy (rsync → install → migrate → restart)
bunx upend deploy
```

### Register JWKS (after first deploy)

Neon needs to reach your JWKS URL to validate JWTs for the Data API. After your first deploy, when your domain is live:

```bash
bunx upend setup:jwks
```

## CLI Commands

| Command | What |
|---------|------|
| `upend init <name>` | Scaffold a new project (creates Neon DB, generates keys, encrypts env) |
| `upend dev` | Start gateway + claude + caddy locally |
| `upend migrate` | Run SQL migrations from `migrations/` |
| `upend deploy` | rsync to remote, install, migrate, restart |
| `upend infra:aws` | Provision an EC2 instance |

## Config

`upend.config.ts`:

```ts
import { defineConfig } from "@upend/cli";

export default defineConfig({
  name: "my-project",
  database: process.env.DATABASE_URL,
  dataApi: process.env.NEON_DATA_API,
  deploy: {
    host: process.env.DEPLOY_HOST,
    dir: "/opt/upend",
  },
});
```

## Philosophy

- **One server per customer.** Vertical scaling. No multi-tenant complexity.
- **No git workflows.** Claude edits live (in a worktree). Publish when ready.
- **No CI/CD.** `rsync --delete` is the deploy.
- **No build step.** Bun runs TypeScript directly. Apps are static files.
- **Encrypted env.** `.env` is encrypted with dotenvx — safe to commit. `.env.keys` is gitignored.
- **Snapshots, not rollback strategies.** Before any change, snapshot files + database. Undo = restore.
