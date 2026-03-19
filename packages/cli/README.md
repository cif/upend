# upend

Anti-SaaS stack. Your code, your server, your database. Deploy via rsync. Edit live with Claude.

Bun + Hono + Neon Postgres + Caddy. Custom JWT auth. Claude editing sessions with git worktree isolation.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Caddy](https://caddyserver.com) — `brew install caddy`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
- [neonctl](https://neon.tech/docs/reference/neon-cli) — `npm i -g neonctl`

## Quickstart

```bash
bunx @upend/cli init my-project
cd my-project
bunx upend migrate
bunx upend dev
```

Open http://localhost:4000.

## Project structure

```
my-project/
├── apps/                 → frontend apps (HTML/JS/CSS)
│   └── users/            → built-in user management app
├── services/             → custom backend services (Hono APIs)
├── tasks/                → background tasks (cron or manual)
├── migrations/           → SQL migrations (numbered)
├── .env                  → secrets (gitignored, Bun auto-loads)
├── .keys/                → JWT signing keys (gitignored)
├── upend.config.ts       → project config
├── CLAUDE.md             → instructions for Claude
└── package.json
```

## Architecture

```
                         :4000 (Caddy)
                              │
                 ┌────────────┴────────────┐
                 │                         │
           /claude/*                  everything else
                 │                         │
          Claude Service              Gateway :3001
            :3002                          │
          ┌──────────┐      ┌──────────────┼──────────────┐
          │ sessions │      │              │              │
          │ websocket│    /api/*      /apps/*      /services/*
          │ preview  │      │          │              │
          └──────────┘    built-in    static       dispatcher
                            │        files       (dynamic import)
                     ┌──────┼──────┐
                     │      │      │
                   auth   data   tasks
                   JWKS   CRUD   audit
                   SSO    RLS    policies
                              │
                         ┌────┴────┐
                         │ Postgres │
                         │  (Neon)  │
                         └─────────┘
```

Caddy only does two things: route `/claude/*` to the Claude service, and send everything else to the gateway. Cloudflare handles TLS in production.

### The gateway

The gateway is the framework layer. It handles auth, data, and dispatches to your custom code:

| Endpoint | What |
|----------|------|
| `POST /api/auth/signup` | Create account `{email, password}` → `{user, token}` |
| `POST /api/auth/login` | Login `{email, password}` → `{user, token}` |
| `POST /api/auth/impersonate` | Admin: mint token as another user |
| `GET /api/auth/sso/:provider` | OAuth login (GitHub, Google, etc) |
| `GET /.well-known/jwks.json` | Public keys for JWT verification |
| `GET/POST/PATCH/DELETE /api/data/:table` | CRUD any public table (RLS enforced) |
| `GET /api/tables` | List tables |
| `GET /api/tables/:name` | Table columns |
| `GET /api/policies` | RLS policies |
| `GET /api/audit` | Audit log |
| `GET /api/tasks` | List tasks |
| `POST /api/tasks/:name/run` | Run a task (admin only) |
| `GET /apps/*` | Serve frontend apps (with auth) |
| `ALL /services/:name/*` | Dispatch to custom services |

### Three types of user code

**Apps** (`apps/<name>/`) — Frontend HTML/JS/CSS. Served at `/apps/<name>/`. No build step.

```js
const token = localStorage.getItem('upend_token');
const res = await fetch('/api/data/projects', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

**Services** (`services/<name>/index.ts`) — Custom backend APIs. Auto-mounted at `/services/<name>/*`.

```ts
// services/goodbyes/index.ts
import { Hono } from "hono";
import { sql } from "../../lib/db";

const app = new Hono();
app.get("/random", async (c) => {
  const [row] = await sql`SELECT * FROM goodbyes ORDER BY random() LIMIT 1`;
  return c.json(row);
});
export default app;
// → GET /services/goodbyes/random
```

**Tasks** (`tasks/<name>.ts`) — Background functions. Run via API, dashboard button, or cron.

```ts
// tasks/daily-report.ts
// @cron 0 9 * * *
// @description send the daily report
import { notify } from "../lib/notify";

export async function run() {
  await notify({ email: "team@example.com", subject: "Daily Report", body: "..." });
}
run().then(() => process.exit(0));
// → POST /api/tasks/daily-report/run
```

## Data API

Every table in the `public` schema is available via `/api/data/:table`:

```bash
TOKEN="eyJ..."

# list
curl '/api/data/projects?order=created_at.desc&limit=10' \
  -H "Authorization: Bearer $TOKEN"

# filter
curl '/api/data/projects?status=eq.active&owner_id=eq.abc-123' \
  -H "Authorization: Bearer $TOKEN"

# create
curl -X POST /api/data/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"new project"}'

# update
curl -X PATCH '/api/data/projects?id=eq.5' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"updated"}'

# delete
curl -X DELETE '/api/data/projects?id=eq.5' \
  -H "Authorization: Bearer $TOKEN"
```

Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`.

### RLS (Row Level Security)

The data API sets JWT claims as Postgres session variables before every query:
- `current_setting('request.jwt.sub')` — user ID
- `current_setting('request.jwt.role')` — user role
- `current_setting('request.jwt.email')` — user email

Create RLS policies in migrations:

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY "read_all" ON projects FOR SELECT USING (true);
CREATE POLICY "update_own" ON projects FOR UPDATE
  USING (owner_id::text = current_setting('request.jwt.sub'));
CREATE POLICY "admin_delete" ON projects FOR DELETE
  USING (current_setting('request.jwt.role') = 'admin');
```

The dashboard data tab shows active RLS policies per table.

## Notifications

```ts
import { notify } from "../lib/notify";

// email (requires RESEND_API_KEY in .env)
await notify({ email: "ben@example.com", subject: "Done", body: "..." });

// slack webhook (requires SLACK_WEBHOOK_URL in .env)
await notify({
  webhook: process.env.SLACK_WEBHOOK_URL,
  payload: { message: "task complete", url: "https://..." }
});

// both at once
await notify({ email: "...", webhook: "...", subject: "Alert", body: "..." });
```

## Audit log

Every login, signup, impersonation, and task run is logged to `audit.log` (append-only, protected by RLS — no updates or deletes). Visible in the dashboard audit tab.

## Editing with Claude

The dashboard at `/` has a built-in chat. Each conversation creates an isolated git worktree — Claude edits files there, you preview the changes, then click **Publish** to merge into live.

If something breaks, close the session without publishing. Your live code is untouched.

## Deploy

```bash
# provision an EC2 instance
bunx upend infra:aws

# set deploy target
bunx upend env:set DEPLOY_HOST ec2-user@<ip>

# deploy (rsync → install → migrate → restart → install cron tasks)
bunx upend deploy

# check health
bunx upend status

# tail logs
bunx upend logs
bunx upend logs api -f

# SSH in
bunx upend ssh
bunx upend ssh "bun -v"
```

## CLI Commands

| Command | What |
|---------|------|
| `upend init <name>` | Scaffold project (creates Neon DB, keys, admin user) |
| `upend dev` | Start gateway + claude + caddy locally |
| `upend migrate` | Run SQL migrations |
| `upend deploy` | rsync to remote, install, migrate, restart |
| `upend status` | Check remote service health |
| `upend logs [service]` | Tail remote logs (`-f` to follow) |
| `upend ssh [cmd]` | SSH into remote instance |
| `upend tasks` | List tasks and cron schedules |
| `upend tasks run <name>` | Run a task manually |
| `upend tasks install` | Install cron schedules |
| `upend env:set <K> <V>` | Set an env var in .env |
| `upend infra:aws` | Provision an EC2 instance |

## Philosophy

- **One server per customer.** Vertical scaling. No multi-tenant complexity.
- **No git workflows.** Claude edits in a worktree. Publish when ready.
- **No CI/CD.** `rsync --delete` is the deploy.
- **No build step.** Bun runs TypeScript directly. Apps are static files.
- **Plain `.env`.** Gitignored. No encryption overhead. rsync to deploy secrets.
- **Audit everything.** Append-only log. No one can delete it.
