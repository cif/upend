import { log } from "../lib/log";
import { exec } from "../lib/exec";

export default async function status(args: string[]) {
  const host = process.env.DEPLOY_HOST;
  const sshKey = process.env.DEPLOY_SSH_KEY || `${process.env.HOME}/.ssh/upend.pem`;

  if (!host) {
    log.error("DEPLOY_HOST not set. Add it to .env");
    process.exit(1);
  }

  const appDir = process.env.DEPLOY_DIR || "/opt/upend";

  log.header(`${host}`);

  // check services
  const { stdout } = await exec(["ssh", "-i", sshKey, host, `bash -c '
    echo "=== services ==="
    pgrep -af "bun services/api" > /dev/null && echo "api: running" || echo "api: stopped"
    pgrep -af "bun services/claude" > /dev/null && echo "claude: running" || echo "claude: stopped"
    pgrep -af "caddy" > /dev/null && echo "caddy: running" || echo "caddy: stopped"

    echo ""
    echo "=== health ==="
    curl -s -o /dev/null -w "api: %{http_code}" http://localhost:3001/ 2>/dev/null || echo "api: unreachable"
    echo ""
    curl -s -o /dev/null -w "caddy: %{http_code}" http://localhost:80/ 2>/dev/null || echo "caddy: unreachable"
    echo ""

    echo ""
    echo "=== system ==="
    uptime
    df -h / | tail -1 | awk "{print \"disk: \" \\$3 \" used / \" \\$2 \" (\" \\$5 \")\"}"
    free -h 2>/dev/null | awk "/Mem:/{print \"memory: \" \\$3 \" used / \" \\$2}" || echo "memory: n/a"

    echo ""
    echo "=== workflows (crontab) ==="
    crontab -l 2>/dev/null | grep "upend-workflow" || echo "none installed"

    echo ""
    echo "=== last deploy ==="
    cd ${appDir} && git log --oneline -1 2>/dev/null || echo "no git history"
  '`]);

  console.log(stdout);
}
