import { log } from "../lib/log";
import { exec, execOrDie, hasCommand } from "../lib/exec";
import { resolve } from "path";

export default async function deploy(args: string[]) {
  const projectDir = resolve(".");
  const host = process.env.DEPLOY_HOST;
  const sshKey = process.env.DEPLOY_SSH_KEY || `${process.env.HOME}/.ssh/upend.pem`;

  if (!host) {
    log.error("DEPLOY_HOST not set. Add it to .env (e.g. ec2-user@1.2.3.4)");
    process.exit(1);
  }

  const appDir = process.env.DEPLOY_DIR || "/opt/upend";
  const ssh = (cmd: string) => execOrDie(["ssh", "-i", sshKey, host, cmd]);

  log.header(`deploying to ${host}`);

  // step 1: stop services
  log.info("stopping services...");
  await ssh("pkill -f 'bun services/' 2>/dev/null || true; sudo pkill caddy 2>/dev/null || true; sleep 1");
  log.success("services stopped");

  // step 2: full rsync
  log.info("pushing files...");
  await ssh(`sudo mkdir -p ${appDir} && sudo chown $(whoami):$(whoami) ${appDir}`);
  await execOrDie([
    "rsync", "-azP", "--delete",
    "--exclude", "node_modules",
    "--exclude", ".env.keys",
    "--exclude", ".keys",
    "--exclude", ".snapshots",
    "--exclude", ".git",
    "--exclude", "sessions",
    "-e", `ssh -i ${sshKey}`,
    "./", `${host}:${appDir}/`,
  ]);
  log.success("files pushed");

  // step 3: sync secrets
  log.info("syncing secrets...");
  await exec(["rsync", "-azP", "-e", `ssh -i ${sshKey}`, ".env.keys", `${host}:${appDir}/.env.keys`]);
  await exec(["rsync", "-azP", "-e", `ssh -i ${sshKey}`, ".keys/", `${host}:${appDir}/.keys/`]);
  log.success("secrets synced");

  // step 4: install + migrate + start
  log.info("installing deps + migrating + starting...");
  await ssh(`bash -c '
    cd ${appDir}
    bun install
    dotenvx run -- bun src/migrate.ts
    git add -A && git commit -m "deploy $(date +%Y-%m-%d-%H%M)" --allow-empty 2>/dev/null || true
    nohup dotenvx run -- bun services/api/index.ts > /tmp/upend-api.log 2>&1 &
    nohup dotenvx run -- bun services/claude/index.ts > /tmp/upend-claude.log 2>&1 &
    nohup sudo caddy run --config ${appDir}/infra/Caddyfile > /tmp/upend-caddy.log 2>&1 &
    sleep 3
    curl -s -o /dev/null -w "API: %{http_code}\\n" http://localhost:3001/
    curl -s -o /dev/null -w "Caddy: %{http_code}\\n" http://localhost:80/
  '`);
  log.success("deployed");

  log.blank();
  log.header("live!");
  log.info(`ssh ${host} 'tail -f /tmp/upend-*.log'`);
  log.blank();
}
