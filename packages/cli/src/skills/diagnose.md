Diagnose problems with this upend stack. Check services, logs, database, and tasks.

Run these checks in order and report findings:

## 1. Service health
```bash
# local
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "api: unreachable"
curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/ 2>/dev/null || echo "claude: unreachable"
curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/ 2>/dev/null || echo "caddy: unreachable"
```

If DEPLOY_HOST is set, also check remote:
```bash
bunx upend status
```

## 2. Recent errors in logs
```bash
# check local logs
tail -100 /tmp/upend-api.log 2>/dev/null | grep -i "error\|fail\|exception\|EADDRINUSE\|ECONNREFUSED"
tail -100 /tmp/upend-claude.log 2>/dev/null | grep -i "error\|fail\|exception"
```

If remote, use `bunx upend logs api -n 100` and `bunx upend logs claude -n 100`.

## 3. Database connectivity
```bash
bun -e "import {sql} from './node_modules/@upend/cli/src/lib/db'; await sql\`SELECT 1\`; console.log('db: connected'); await sql.end()"
```

## 4. Migration status
```bash
bunx upend migrate
```
This is idempotent — it will show if any migrations are pending.

## 5. Audit log (recent errors)
```bash
bun -e "import {sql} from './node_modules/@upend/cli/src/lib/db'; const r = await sql\`SELECT * FROM audit.log WHERE action LIKE '%error%' OR detail::text LIKE '%error%' ORDER BY ts DESC LIMIT 10\`; console.log(JSON.stringify(r, null, 2)); await sql.end()"
```

## 6. Failed tasks
```bash
bun -e "import {sql} from './node_modules/@upend/cli/src/lib/db'; const r = await sql\`SELECT * FROM audit.log WHERE action = 'task.run' AND (detail->>'exitCode')::int != 0 ORDER BY ts DESC LIMIT 5\`; console.log(JSON.stringify(r, null, 2)); await sql.end()"
```

## Report
After running all checks, summarize:
- Which services are up/down
- Any errors found in logs (with the actual error messages)
- Database connectivity status
- Pending migrations
- Failed tasks

If you find problems, suggest specific fixes.
