# upend — framework architecture

## The split

### `upend` (the npm package)
Installed as a dependency. Provides the runtime, services, and CLI. Never touched by rollback.

```
node_modules/upend/
├── bin/
│   └── upend.ts              → CLI entry: `bunx upend dev`, `bunx upend deploy`, etc.
├── services/
│   ├── claude/                → claude editing sessions, WebSocket, snapshots
│   ├── dashboard/             → dashboard shell (split view, app launcher)
│   └── gateway/               → auth (signup/login/SSO/JWKS), Neon Data API proxy
├── lib/
│   ├── auth.ts                → JWT signing/verification, JWKS
│   ├── db.ts                  → postgres.js connection
│   ├── middleware.ts           → auth middleware
│   └── snapshots.ts           → file + db snapshot/rollback
├── infra/
│   ├── Caddyfile.template     → generated from project config
│   └── upend@.service         → systemd template
└── index.ts                   → starts all services + caddy
```

### Your project (the user code)
This is what `bunx upend init` scaffolds. This is what rollback touches.

```
my-project/
├── apps/                      → hot-deployed frontends
│   ├── dashboard/
│   └── inventory/
├── migrations/                → plain SQL, numbered
│   ├── 001_init.sql
│   └── 002_products.sql
├── services/                  → optional custom services (business logic, webhooks)
│   └── webhooks/
│       └── index.ts
├── upend.config.ts            → project config
├── .env                       → encrypted (dotenvx)
├── .env.keys                  → decryption keys (gitignored)
├── .keys/                     → JWT signing keys (gitignored)
└── .snapshots/                → file + db snapshots (rollback source)
```

## CLI

```bash
# scaffold a new project
bunx upend init my-project

# dev (starts all services + caddy + drizzle studio)
bunx upend dev

# run migrations
bunx upend migrate

# deploy via rsync
bunx upend deploy

# add a custom service
bunx upend add-service webhooks

# snapshot manually
bunx upend snapshot

# rollback (files + db)
bunx upend rollback <snapshot-name>

# upgrade upend itself
bun update upend
```

## upend.config.ts

```ts
import { defineConfig } from "upend";

export default defineConfig({
  // database
  database: process.env.DATABASE_URL,

  // neon data api (PostgREST proxy)
  dataApi: process.env.NEON_DATA_API,

  // auth
  auth: {
    audience: "upend",
    tokenExpiry: "24h",
    // optional OAuth providers
    oauth: {
      google: {
        clientId: process.env.OAUTH_GOOGLE_CLIENT_ID,
        clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET,
      },
    },
  },

  // custom services (in addition to built-in claude + gateway + dashboard)
  services: {
    webhooks: { entry: "services/webhooks/index.ts", port: 3003 },
  },

  // ports
  ports: {
    proxy: 4000,     // caddy
    gateway: 3001,   // auth + data proxy
    claude: 3002,    // claude sessions + apps
  },

  // deploy
  deploy: {
    host: process.env.DEPLOY_HOST,
    dir: "/opt/upend",
  },

  // snapshots
  snapshots: {
    max: 10,
    // what to snapshot (only user stuff, never the framework)
    include: ["apps", "migrations", "services", "upend.config.ts"],
    exclude: ["node_modules", ".env.keys", ".keys"],
  },
});
```

## How rollback changes

Current: snapshots everything including upend's own code.
New: snapshots only the project files listed in `snapshots.include`.

```
.snapshots/
└── snap-2026-03-15T05-06-46/
    ├── files/
    │   ├── apps/          → user's frontend apps
    │   ├── migrations/    → user's SQL migrations
    │   ├── services/      → user's custom services
    │   └── upend.config.ts
    └── db.sql             → pg_dump of public schema only
```

Framework code in `node_modules/upend/` is never snapshotted or rolled back.

## Migration path from current repo

1. Extract `services/claude/`, `services/dashboard/`, `lib/`, `infra/` into an `upend` npm package
2. Current `services/api/` becomes the built-in gateway service
3. User-facing code stays in the project root
4. `upend.config.ts` replaces `infra/services.json` + scattered env var checks
5. CLI wraps everything we currently do in `index.ts` + `deploy.sh` + `new-service.sh`
6. Publish to npm: `@cif/upend` or `upend`
