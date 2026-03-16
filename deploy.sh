#!/usr/bin/env bash
set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST (e.g. ec2-user@1.2.3.4)}"
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/upend.pem}"
APP_DIR="${DEPLOY_DIR:-/opt/upend}"
TARGET="${1:-all}"

SSH="ssh -i $SSH_KEY $HOST"

echo "→ deploying to ${HOST}:${APP_DIR}"

# ---------- ensure remote is ready ----------
echo "→ preparing remote"
$SSH "sudo mkdir -p ${APP_DIR} && sudo chown \$(whoami):\$(whoami) ${APP_DIR}"

# ---------- rsync code ----------
echo "→ syncing code"
rsync -azP --delete \
  --exclude node_modules \
  --exclude .snapshots \
  --exclude .git \
  -e "ssh -i $SSH_KEY" \
  ./ "${HOST}:${APP_DIR}/"

# ---------- sync secrets (keys + env.keys) ----------
echo "→ syncing secrets"
# .env (encrypted) is in the rsync above
# .env.keys has the decryption key — sync separately
[ -f .env.keys ] && rsync -azP -e "ssh -i $SSH_KEY" .env.keys "${HOST}:${APP_DIR}/.env.keys"
# JWT signing keys
[ -d .keys ] && rsync -azP -e "ssh -i $SSH_KEY" .keys/ "${HOST}:${APP_DIR}/.keys/"

# ---------- remote: install, migrate, restart ----------
$SSH "bash -s" -- "$TARGET" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
TARGET="$1"
APP_DIR="/opt/upend"
cd "$APP_DIR"

# install bun if missing
if ! command -v bun &>/dev/null; then
  echo "→ installing bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# install caddy if missing
if ! command -v caddy &>/dev/null; then
  echo "→ installing caddy"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$(uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/amd64/')" -o /tmp/caddy
  sudo mv /tmp/caddy /usr/local/bin/caddy
  sudo chmod +x /usr/local/bin/caddy
fi

echo "→ installing deps"
bun install --frozen-lockfile 2>/dev/null || bun install

echo "→ running migrations"
bunx dotenvx run -- bun src/migrate.ts

# stop existing processes
echo "→ stopping services"
pkill -f "bun services/" 2>/dev/null || true
sudo pkill caddy 2>/dev/null || true
sleep 1

# start services
echo "→ starting services"
SERVICES=$(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('infra/services.json','utf8'))).join(' '))")

if [ "$TARGET" = "all" ]; then
  for svc in $SERVICES; do
    echo "  starting $svc"
    nohup bunx dotenvx run -- bun "services/$svc/index.ts" > "/tmp/upend-$svc.log" 2>&1 &
  done
else
  echo "  starting $TARGET"
  nohup bunx dotenvx run -- bun "services/$TARGET/index.ts" > "/tmp/upend-$TARGET.log" 2>&1 &
fi

# start caddy
echo "→ starting caddy"
nohup sudo /usr/local/bin/caddy run --config "$APP_DIR/infra/Caddyfile" > /tmp/upend-caddy.log 2>&1 &

sleep 3

# verify
echo "→ verifying"
for svc in $SERVICES; do
  PORT=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('infra/services.json','utf8'))['$svc'].port)")
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null || echo "down")
  echo "  $svc (:$PORT) → $STATUS"
done
CADDY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:80/ 2>/dev/null || echo "down")
echo "  caddy (:80) → $CADDY_STATUS"

echo ""
echo "✓ deployed"
echo "  logs: ssh $HOST 'tail -f /tmp/upend-*.log'"
REMOTE
