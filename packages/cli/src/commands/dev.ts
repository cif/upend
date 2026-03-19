import { log } from "../lib/log";
import { hasCommand } from "../lib/exec";
import { existsSync } from "fs";
import { resolve } from "path";

export default async function dev(args: string[]) {
  const projectDir = resolve(".");

  if (!existsSync("upend.config.ts") && !existsSync("package.json")) {
    log.error("not in an upend project (no upend.config.ts found)");
    process.exit(1);
  }

  // find @upend/cli's bundled services
  const cliRoot = new URL("../../", import.meta.url).pathname;

  // ports from env or defaults
  const apiPort = process.env.API_PORT || "3001";
  const claudePort = process.env.CLAUDE_PORT || "3002";
  const proxyPort = process.env.PORT || "4000";

  log.header("starting upend dev");

  // start API service
  log.info(`starting api → :${apiPort}`);
  Bun.spawn(["bun", "--watch", `${cliRoot}/src/services/gateway/index.ts`], {
    cwd: projectDir,
    env: { ...process.env, API_PORT: apiPort, UPEND_PROJECT: projectDir },
    stdout: "inherit",
    stderr: "inherit",
  });

  // start Claude service
  log.info(`starting claude → :${claudePort}`);
  Bun.spawn(["bun", "--watch", `${cliRoot}/src/services/claude/index.ts`], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PORT: claudePort, UPEND_PROJECT: projectDir },
    stdout: "inherit",
    stderr: "inherit",
  });

  // start Caddy
  if (await hasCommand("caddy")) {
    log.info(`starting caddy → :${proxyPort}`);
    const caddyfile = generateCaddyfile(projectDir, cliRoot, apiPort, claudePort, proxyPort);
    const caddyPath = `/tmp/upend-Caddyfile-${proxyPort}`;
    await Bun.write(caddyPath, caddyfile);
    Bun.spawn(["caddy", "run", "--config", caddyPath, "--adapter", "caddyfile"], {
      stdout: "inherit",
      stderr: "inherit",
    });
  } else {
    log.warn("caddy not found — install with: brew install caddy");
    log.warn(`services running on individual ports (${apiPort}, ${claudePort})`);
  }

  log.blank();
  log.header(`upend running on :${proxyPort}`);
  log.info(`http://localhost:${proxyPort}/          → dashboard`);
  log.info(`http://localhost:${proxyPort}/api/      → api`);
  log.info(`http://localhost:${proxyPort}/claude/   → claude`);
  log.info(`http://localhost:${proxyPort}/apps/     → live apps`);
  log.blank();
}

function generateCaddyfile(projectDir: string, cliRoot: string, apiPort: string, claudePort: string, proxyPort: string): string {
  return `:${proxyPort} {
  # Apps (served through gateway for access control)
  handle /apps/* {
    reverse_proxy localhost:${apiPort}
  }

  # User services (dispatched through gateway)
  handle /services/* {
    reverse_proxy localhost:${apiPort}
  }

  # API service (auth, JWKS, tables)
  handle_path /api/* {
    reverse_proxy localhost:${apiPort}
  }

  # Claude service + WebSocket
  handle_path /claude/* {
    reverse_proxy localhost:${claudePort}
  }

  # JWKS
  handle /.well-known/* {
    reverse_proxy localhost:${apiPort}
  }

  # Default → dashboard
  handle {
    root * ${cliRoot}/src/services/dashboard/public
    try_files {path} /index.html
    file_server
  }
}
`;
}
