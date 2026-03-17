import { log } from "../lib/log";
import { exec, execOrDie, hasCommand } from "../lib/exec";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export default async function init(args: string[]) {
  const name = args[0];
  if (!name) {
    log.error("usage: upend init <project-name>");
    process.exit(1);
  }

  const projectDir = resolve(name);

  if (existsSync(projectDir)) {
    log.error(`directory '${name}' already exists`);
    process.exit(1);
  }

  log.header(`creating upend project: ${name}`);

  // create project directory
  mkdirSync(projectDir, { recursive: true });

  // scaffold files
  log.info("scaffolding project...");

  writeFile(projectDir, "upend.config.ts", `import { defineConfig } from "@upend/cli";

export default defineConfig({
  name: "${name}",
});
`);

  writeFile(projectDir, "package.json", JSON.stringify({
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "upend dev",
      deploy: "upend deploy",
      migrate: "upend migrate",
    },
    dependencies: {
      "@upend/cli": "^0.1.0",
    },
  }, null, 2) + "\n");

  writeFile(projectDir, ".gitignore", `node_modules/
.env.keys
.keys/
.snapshots/
sessions/
*.log
.DS_Store
`);

  writeFile(projectDir, ".env.example", `DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
ANTHROPIC_API_KEY=sk-ant-...
`);

  // migrations
  mkdirSync(join(projectDir, "migrations"), { recursive: true });
  writeFile(projectDir, "migrations/001_init.sql", `-- your first migration
-- create your tables here

CREATE TABLE IF NOT EXISTS example (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
`);

  // apps
  mkdirSync(join(projectDir, "apps"), { recursive: true });
  writeFile(projectDir, "apps/.gitkeep", "");

  // services (custom)
  mkdirSync(join(projectDir, "services"), { recursive: true });
  writeFile(projectDir, "services/.gitkeep", "");

  // CLAUDE.md
  writeFile(projectDir, "CLAUDE.md", `# ${name}

You have FULL control of this codebase. Edit anything. Run anything. Create migrations. You are the developer.

Changes take effect immediately (Bun --watch). A snapshot was taken before you started — if something breaks, the user can rollback.

## What you can do
- Edit any file in the project
- Create new files, migrations, apps
- Run \`upend migrate\` to apply database migrations
- Run any bash command
- Create apps in \`apps/\` that are instantly served

## Conventions
- Migrations are plain SQL in \`migrations/\`, numbered \`001_name.sql\`
- Apps are static HTML/JS/CSS in \`apps/<name>/\`
- Custom services go in \`services/<name>/index.ts\`
`);

  log.success("project scaffolded");

  // check for neon CLI
  log.info("checking for neon CLI...");
  if (await hasCommand("neonctl")) {
    log.success("neon CLI found");
    await setupNeon(projectDir, name);
  } else {
    log.warn("neon CLI not found — install with: npm i -g neonctl");
    log.warn("then run: neonctl auth && upend init:db");
    log.dim("or set DATABASE_URL manually in .env");
  }

  // generate JWT keys
  log.info("generating JWT signing keys...");
  mkdirSync(join(projectDir, ".keys"), { recursive: true });
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const privPem = await exportKeyToPem(privateKey, "PRIVATE");
  const pubPem = await exportKeyToPem(publicKey, "PUBLIC");
  writeFileSync(join(projectDir, ".keys/private.pem"), privPem);
  writeFileSync(join(projectDir, ".keys/public.pem"), pubPem);
  log.success("JWT keys generated");

  // git init
  log.info("initializing git...");
  await execOrDie(["git", "init"], { cwd: projectDir });
  await execOrDie(["git", "add", "-A"], { cwd: projectDir });
  await execOrDie(["git", "commit", "-m", "initial commit"], { cwd: projectDir });
  log.success("git initialized");

  // install deps
  log.info("installing dependencies...");
  await execOrDie(["bun", "install"], { cwd: projectDir });
  log.success("dependencies installed");

  log.header("done!");
  log.info(`cd ${name}`);
  log.info(`upend dev`);
  log.blank();
}

async function setupNeon(projectDir: string, name: string) {
  log.info("setting up neon database...");

  // check auth
  const { exitCode } = await exec(["neonctl", "me"], { silent: true });
  if (exitCode !== 0) {
    log.info("authenticating with neon...");
    await execOrDie(["neonctl", "auth"]);
  }

  // create project
  log.info("creating neon project...");
  const { stdout: projectJson } = await execOrDie(["neonctl", "projects", "create", "--name", name, "--output", "json"]);
  const project = JSON.parse(projectJson);
  const projectId = project.project?.id || project.id;
  log.success(`neon project created: ${projectId}`);

  // get connection string
  const { stdout: connStr } = await execOrDie(["neonctl", "connection-string", "--project-id", projectId]);
  log.success("got connection string");

  // write .env
  writeFile(projectDir, ".env", `DATABASE_URL="${connStr}"
ANTHROPIC_API_KEY=
API_PORT=3001
CLAUDE_PORT=3002
`);

  // encrypt
  log.info("encrypting .env...");
  await exec(["npx", "dotenvx", "encrypt"], { cwd: projectDir });
  log.success(".env encrypted");
}

function writeFile(dir: string, path: string, content: string) {
  const fullPath = join(dir, path);
  const parent = join(fullPath, "..");
  mkdirSync(parent, { recursive: true });
  writeFileSync(fullPath, content);
}

async function exportKeyToPem(key: CryptoKey, type: "PRIVATE" | "PUBLIC") {
  const format = type === "PRIVATE" ? "pkcs8" : "spki";
  const exported = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(exported).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${type} KEY-----\n${lines}\n-----END ${type} KEY-----\n`;
}
