#!/usr/bin/env bash
# Run this ONCE on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu)
set -euo pipefail

ARCH=$(uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/amd64/')

echo "→ installing bun"
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version

echo "→ installing node (required by claude code)"
if command -v dnf &>/dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf install -y nodejs
elif command -v apt-get &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "→ installing caddy"
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /tmp/caddy
sudo mv /tmp/caddy /usr/local/bin/caddy
sudo chmod +x /usr/local/bin/caddy
caddy version

echo "→ installing claude code"
bun install -g @anthropic-ai/claude-code
claude --version

echo "→ symlinking binaries to /usr/local/bin"
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
sudo ln -sf "$HOME/.bun/bin/bunx" /usr/local/bin/bunx
sudo ln -sf "$HOME/.bun/bin/claude" /usr/local/bin/claude
sudo ln -sf "$HOME/.bun/bin/dotenvx" /usr/local/bin/dotenvx

echo "→ setting up /opt/upend"
sudo mkdir -p /opt/upend
sudo chown "$(whoami):$(whoami)" /opt/upend

echo "✓ setup complete"
echo "  now run: ./deploy.sh"
