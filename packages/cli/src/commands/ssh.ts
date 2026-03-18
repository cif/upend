import { log } from "../lib/log";

export default async function ssh(args: string[]) {
  const host = process.env.DEPLOY_HOST;
  const sshKey = process.env.DEPLOY_SSH_KEY || `${process.env.HOME}/.ssh/upend.pem`;
  const appDir = process.env.DEPLOY_DIR || "/opt/upend";

  if (!host) {
    log.error("DEPLOY_HOST not set. Add it to .env");
    process.exit(1);
  }

  // if args provided, run as remote command
  if (args.length > 0) {
    const cmd = args.join(" ");
    log.dim(`ssh ${host} → ${cmd}`);
    const proc = Bun.spawn(["ssh", "-i", sshKey, host, `cd ${appDir} && ${cmd}`], {
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(await proc.exited);
  }

  // otherwise, interactive shell
  log.dim(`ssh ${host} (cd ${appDir})`);
  const proc = Bun.spawn(["ssh", "-i", sshKey, "-t", host, `cd ${appDir} && exec bash`], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await proc.exited);
}
