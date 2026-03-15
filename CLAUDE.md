# upend

Anti-SaaS stack. Vertical scaling. No CI/CD. Deploy via rsync.

## Stack
- **Runtime**: Bun
- **Framework**: Hono
- **Database**: Neon Postgres via postgres.js
- **Env**: dotenvx (encrypted .env, .env.keys stays local)
- **Deploy**: rsync → EC2, systemd per service, Caddy reverse proxy

## Project structure
- `services/<name>/index.ts` — each service is its own Hono server on its own port
- `lib/` — shared code (db, utils)
- `infra/` — Caddyfile, systemd template, services.json, setup script
- `migrations/` — plain SQL files, numbered `001_name.sql`

## Commands
- `bun run dev` — start all services with hot reload
- `bun run dev:api` / `bun run dev:claude` — start one service
- `bun run migrate` — run SQL migrations
- `./deploy.sh` — deploy all services
- `./deploy.sh api` — deploy + restart one service
- `./new-service.sh <name> [port]` — scaffold a new service

## Services
- **api** (:3001) — generic CRUD + SSE log streaming
- **claude** (:3002) — Claude editing sessions via subprocess

## Conventions
- Adding a service: `./new-service.sh foo` → creates entry, routes Caddy, registers in services.json
- On server: `sudo systemctl enable upend@foo` to autostart
- Logs: `journalctl -u upend@api -f`
- No git workflows, no PRs, no CI. Edit, save, deploy.
