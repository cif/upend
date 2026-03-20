# Architecture: Dispatcher, Sessions & Live Editing

## Overview

upend runs two Bun services behind a Caddy reverse proxy. Every request — whether it's loading an app, calling a service, or running a task — flows through the **API gateway** (`services/api/`), which acts as a dispatcher. The key design decision: user code (apps, services, tasks) is loaded dynamically from the filesystem at request time, not bundled or compiled. Edit a file, the next request serves the new version.

## Runtime

Everything runs on **Bun** — the TypeScript runtime, HTTP server, and process manager. No Node.js in the hot path. Services are plain TypeScript files that export a Hono app or a default function. Bun's native `import()` loads them on demand.

There's no build step, no bundler, no transpiler in the loop. Bun runs TypeScript directly. Apps are plain HTML/JS/CSS served as static files.

## Request flow

```
Client → Caddy (:80) → API gateway (:3001) → dispatcher → user code
                     → Claude service (:3002) → sessions, websocket
```

Caddy routes `/claude/*` to the Claude service and everything else to the API gateway. The API gateway handles auth, data CRUD, and dispatches to user apps and services.

## The dispatcher

The dispatcher is the core of the gateway (`services/api/index.ts`). It serves three types of user code:

### Apps (`/apps/*`)

Static file serving with auth. Resolves files from `apps/<name>/` on disk:

```
GET /apps/crm/           → apps/crm/index.html
GET /apps/crm/styles.css → apps/crm/styles.css
```

No build step. Write HTML, it's live. Cache headers are set to `no-cache, no-store` so edits appear immediately.

### Services (`/services/:name/*`)

Dynamic dispatch to backend Hono apps. Each service is a directory with an `index.ts` that exports a Hono app:

```
GET /services/users/list → services/users/index.ts (handles /list)
```

The dispatcher uses **Bun's native `import()`** with a cache-busting timestamp query parameter:

```ts
const mod = await import(`${entryPath}?t=${stat.mtimeMs}`);
```

This is the hot-reload mechanism. On each request, the dispatcher checks the file's `mtime`. If it changed since last import, Bun re-imports the module. If not, it serves from an in-memory cache. No file watcher, no restart — just `stat()` on every request.

The imported module's `default.fetch` is called with a rewritten URL (stripping the `/services/<name>` prefix), so the service sees clean paths like `/list`, `/random`, etc.

### Tasks (`POST /api/tasks/:name/run`)

Tasks are TypeScript files in `tasks/`. The gateway spawns them as child processes via `Bun.spawn(["bun", filePath])`. They run to completion and exit. The gateway also runs a cron scheduler that checks task files for `// @cron` comments and spawns them on schedule.

## Session-aware routing (worktrees)

This is where it gets interesting. When a user starts an editing session through the dashboard, the Claude service creates a **git worktree** — a full copy of the project on a separate branch:

```
/opt/upend/                            ← main (live)
/opt/upend/sessions/bold-delta-9/      ← worktree (session branch)
```

The worktree gets symlinked `node_modules` and copied `.env` so it can run immediately.

### How requests route to worktrees

Every request handler in the gateway calls `resolveRoot(c)` before touching the filesystem. This function checks for a session identifier in three places:

```ts
function resolveRoot(c): string {
  const session = c.req.header("X-Upend-Session")
    || c.req.query("_session")
    || c.req.header("Cookie")?.match(/upend_session=([^;]+)/)?.[1];
  if (session && session !== "main") {
    const sessionPath = join(SESSIONS_DIR, session);
    if (existsSync(sessionPath)) return sessionPath;
  }
  return PROJECT_ROOT;
}
```

If a session is active, the resolved root points to the worktree. All file lookups — apps, services, tasks — check the worktree first, then fall back to main. This means:

- **Apps** edited in a session are served from the worktree to that user, while other users see the live version
- **Services** edited in a session are imported from the worktree path
- **Tasks** created in a session run from the worktree directory

The session identifier flows through the system via the `X-Upend-Session` header (set by the dashboard), a `_session` query param, or a cookie.

### The editing lifecycle

1. **Start session** → creates a git worktree on a named branch (`session/bold-delta-9`)
2. **Claude edits files** → all changes happen in the worktree directory, never in `/opt/upend/` directly
3. **Preview** → the dispatcher serves the worktree version to the session user
4. **Publish** → commits worktree changes, merges the session branch into main, restarts services
5. **Cleanup** → worktree and branch can be removed

The merge uses `git merge-tree` for conflict detection (doesn't touch the working tree) and falls back to file-copy for unrelated histories. After merge, the gateway calls `restartServices()` which kills and respawns the API process so it picks up the new code.

### Claude runs in the worktree

When a session message is sent, the Claude service spawns `claude` (Claude Code CLI) with the worktree as its working directory:

```ts
const proc = Bun.spawn(args, {
  cwd: worktreePath,  // ← session worktree, not main
  env: { ...process.env },
  stdout: "pipe",
  stderr: "pipe",
});
```

Claude's system prompt tells it to only write files within the worktree. Its output streams back to the dashboard via WebSocket in real-time.

## What's NOT in the dispatcher

The **data API** (`/api/data/:table`) goes directly to Postgres with RLS enforcement — no filesystem routing. See `DATA_AND_RLS.md`.

The **dashboard** (`services/dashboard/public/`) is a catch-all static file handler. It's the SPA shell that wraps everything.

**Auth** (`/api/auth/*`) is handled by dedicated routes in `services/api/auth-routes.ts`, not dispatched.

## Why this works

The filesystem *is* the deployment. There's no artifact registry, no container image, no deployment pipeline. Bun's ability to `import()` TypeScript directly and serve it without compilation is what makes the whole thing possible. The dispatcher is just a thin layer that maps URLs to files and checks `mtime` for cache invalidation.

Git worktrees give session isolation for free — each session gets its own branch and directory without copying the entire repo. The dispatcher's `resolveRoot` function is the only code that needs to know about sessions; everything else just works with whatever root it's given.
