import { log } from "../lib/log";
import { exec } from "../lib/exec";

export default async function logs(args: string[]) {
  const host = process.env.DEPLOY_HOST;
  const sshKey = process.env.DEPLOY_SSH_KEY || `${process.env.HOME}/.ssh/upend.pem`;

  if (!host) {
    log.error("DEPLOY_HOST not set. Add it to .env");
    process.exit(1);
  }

  const service = args[0]; // api, claude, caddy, workflow-<name>, or blank for all
  let logFiles: string;

  if (service === "api") {
    logFiles = "/tmp/upend-api.log";
  } else if (service === "claude") {
    logFiles = "/tmp/upend-claude.log";
  } else if (service === "caddy") {
    logFiles = "/tmp/upend-caddy.log";
  } else if (service?.startsWith("workflow-")) {
    logFiles = `/tmp/upend-workflow-${service.replace("workflow-", "")}.log`;
  } else {
    logFiles = "/tmp/upend-api.log /tmp/upend-claude.log /tmp/upend-caddy.log";
  }

  const lines = args.includes("-n") ? args[args.indexOf("-n") + 1] || "50" : "50";
  const follow = args.includes("-f") || args.includes("--follow");

  const tailCmd = follow
    ? `tail -f ${logFiles}`
    : `tail -n ${lines} ${logFiles}`;

  log.dim(`ssh ${host} → ${tailCmd}`);

  // use spawn for streaming output (especially -f)
  const proc = Bun.spawn(["ssh", "-i", sshKey, host, tailCmd], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
