#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?Usage: ./new-service.sh <name> [port]}"
PORT="${2:-$(( 3000 + $(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('infra/services.json','utf8'))).length + 1)") ))}"
ENV_VAR="$(echo "${NAME}" | tr '[:lower:]' '[:upper:]')_PORT"

DIR="services/${NAME}"
mkdir -p "${DIR}"

cat > "${DIR}/index.ts" <<EOF
import { Hono } from "hono";
import { logger } from "hono/logger";

const app = new Hono();
app.use("*", logger());

app.get("/", (c) => c.json({ service: "${NAME}", status: "up", ts: Date.now() }));

// add your routes here

const port = Number(process.env.${ENV_VAR}) || ${PORT};
console.log(\`[${NAME}] running on :\${port}\`);

export default { port, fetch: app.fetch };
EOF

# add to services.json
bun -e "
const f = 'infra/services.json';
const s = JSON.parse(require('fs').readFileSync(f, 'utf8'));
s['${NAME}'] = { entry: 'services/${NAME}/index.ts', port: ${PORT}, env: '${ENV_VAR}' };
require('fs').writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
"

# add route to Caddyfile
sed -i '' "/# Default/i\\
  # ${NAME} service\\
  handle /${NAME}/* {\\
    reverse_proxy localhost:${PORT}\\
  }\\
" infra/Caddyfile

echo "✓ created service '${NAME}' on port ${PORT}"
echo "  → edit ${DIR}/index.ts"
echo "  → deploy with: ./deploy.sh ${NAME}"
echo "  → enable on server: sudo systemctl enable upend@${NAME}"
