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

  log.header("starting upend dev");

  // start API service
  log.info("starting api → :3001");
  Bun.spawn(["bun", "--watch", `${cliRoot}/src/services/gateway/index.ts`], {
    env: { ...process.env, API_PORT: "3001", UPEND_PROJECT: projectDir },
    stdout: "inherit",
    stderr: "inherit",
  });

  // start Claude service
  log.info("starting claude → :3002");
  Bun.spawn(["bun", "--watch", `${cliRoot}/src/services/claude/index.ts`], {
    env: { ...process.env, CLAUDE_PORT: "3002", UPEND_PROJECT: projectDir },
    stdout: "inherit",
    stderr: "inherit",
  });

  // start Caddy
  if (await hasCommand("caddy")) {
    log.info("starting caddy → :4000");
    // generate Caddyfile from config
    const caddyfile = generateCaddyfile(projectDir, cliRoot);
    const caddyPath = "/tmp/upend-Caddyfile";
    await Bun.write(caddyPath, caddyfile);
    Bun.spawn(["caddy", "run", "--config", caddyPath], {
      stdout: "inherit",
      stderr: "inherit",
    });
  } else {
    log.warn("caddy not found — install with: brew install caddy");
    log.warn("services running on individual ports (3001, 3002)");
  }

  log.blank();
  log.header("upend running on :4000");
  log.info("http://localhost:4000/          → dashboard");
  log.info("http://localhost:4000/api/      → api");
  log.info("http://localhost:4000/claude/   → claude");
  log.info("http://localhost:4000/apps/     → live apps");
  log.blank();
}

function generateCaddyfile(projectDir: string, cliRoot: string): string {
  return `:4000 {
  # Live apps
  handle_path /apps/* {
    root * ${projectDir}/apps
    try_files {path} {path}/index.html
    file_server
  }

  # API service (auth, JWKS, tables)
  handle_path /api/* {
    reverse_proxy localhost:3001
  }

  # Claude service + WebSocket
  handle_path /claude/* {
    reverse_proxy localhost:3002
  }

  # JWKS
  handle /.well-known/* {
    reverse_proxy localhost:3001
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
