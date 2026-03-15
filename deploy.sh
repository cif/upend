#!/usr/bin/env bash
set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST (e.g. ec2-user@1.2.3.4)}"
APP_DIR="${DEPLOY_DIR:-/opt/upend}"
STAGING="${APP_DIR}/.staging"

# deploy a single service or all
TARGET="${1:-all}"

echo "→ syncing to ${HOST}:${STAGING}"

rsync -azP --delete \
  --exclude node_modules \
  --exclude .env.keys \
  --exclude .snapshots \
  --exclude .git \
  ./ "${HOST}:${STAGING}/"

ssh "${HOST}" bash -s -- "${TARGET}" <<'REMOTE'
set -euo pipefail
TARGET="$1"
cd /opt/upend/.staging

bun install --frozen-lockfile 2>/dev/null || bun install

# run migrations
npx dotenvx run -- bun src/migrate.ts

# atomic swap
echo "→ swapping into live"
rsync -a --delete --exclude .staging --exclude .env.keys --exclude .snapshots --exclude node_modules \
  /opt/upend/.staging/ /opt/upend/

# copy node_modules too (bun install already ran)
rsync -a /opt/upend/.staging/node_modules/ /opt/upend/node_modules/

# restart services
cd /opt/upend
if [ "$TARGET" = "all" ]; then
  echo "→ restarting all services"
  # read service names from infra/services.json
  for svc in $(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('infra/services.json','utf8'))).join(' '))"); do
    echo "  restarting upend@${svc}"
    sudo systemctl restart "upend@${svc}" 2>/dev/null || echo "  (not yet enabled — run: sudo systemctl enable upend@${svc})"
  done
else
  echo "→ restarting upend@${TARGET}"
  sudo systemctl restart "upend@${TARGET}"
fi

# reload caddy if config changed
sudo systemctl reload caddy 2>/dev/null || true

echo "✓ deployed"
REMOTE
