#!/usr/bin/env bash
# Run this ONCE on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu)
set -euo pipefail

echo "→ installing bun"
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

echo "→ installing caddy"
if command -v dnf &>/dev/null; then
  sudo dnf install -y 'dnf-command(copr)'
  sudo dnf copr enable -y @caddy/caddy
  sudo dnf install -y caddy
elif command -v apt-get &>/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi

echo "→ installing dotenvx"
npm install -g @dotenvx/dotenvx

echo "→ installing claude code"
npm install -g @anthropic-ai/claude-code

echo "→ setting up upend user + dirs"
sudo useradd -r -m -s /bin/bash upend 2>/dev/null || true
sudo mkdir -p /opt/upend
sudo chown upend:upend /opt/upend

echo "→ installing systemd template"
sudo cp /opt/upend/infra/upend@.service /etc/systemd/system/
sudo systemctl daemon-reload

echo "→ setting up caddy"
sudo cp /opt/upend/infra/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl start caddy

echo "→ enabling services"
for svc in $(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('/opt/upend/infra/services.json','utf8'))).join(' '))"); do
  sudo systemctl enable "upend@${svc}"
  sudo systemctl start "upend@${svc}"
done

echo "✓ setup complete"
echo "  services: sudo systemctl status 'upend@*'"
echo "  logs: journalctl -u 'upend@api' -f"
