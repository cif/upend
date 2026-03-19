Guide the user through deploying their upend stack.

## Pre-flight checks

```bash
# verify we're in an upend project
ls upend.config.ts || echo "Not in an upend project directory"

# check DEPLOY_HOST is set
bunx upend env:set 2>&1 | head -1 || echo "Run from project root"
```

Check if DEPLOY_HOST is configured. If not:
```
bunx upend env:set DEPLOY_HOST ec2-user@<your-instance-ip>
```

If no instance exists yet, suggest: "Run /aws to provision one first."

## Deploy

```bash
bunx upend deploy
```

This does:
1. Stops running services on remote
2. rsync pushes all files (excludes node_modules, .keys, .env.keys, .git, sessions)
3. Syncs secrets (.env.keys, .keys/)
4. Runs `bun install` + `bunx upend migrate` on remote
5. Starts api, claude, and caddy services
6. Installs task cron schedules
7. Health checks api and caddy

## Verify

```bash
bunx upend status
bunx upend logs -n 20
```

Check the site in a browser: `https://<your-domain>/`

## If something goes wrong

```bash
# check what's running
bunx upend ssh "pgrep -af bun"

# check logs
bunx upend logs api
bunx upend logs claude

# restart manually
bunx upend ssh "pkill -f 'bun services/' && cd /opt/upend && nohup dotenvx run -- bun services/api/index.ts > /tmp/upend-api.log 2>&1 &"

# or run full diagnose
```
Then suggest running `/diagnose`.
