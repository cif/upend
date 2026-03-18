import { log } from "../lib/log";
import { exec, execOrDie, hasCommand } from "../lib/exec";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, resolve } from "path";

export default async function init(args: string[]) {
  const name = args[0];
  if (!name) {
    log.error("usage: upend init <name>");
    log.dim("  e.g. upend init beta → deploys to beta.upend.site");
    process.exit(1);
  }

  const projectDir = resolve(name);
  const domain = `${name}.upend.site`;

  if (existsSync(projectDir)) {
    log.error(`directory '${name}' already exists`);
    process.exit(1);
  }

  log.header(`creating ${name}`);
  log.dim(`→ ${domain}`);
  log.blank();

  mkdirSync(projectDir, { recursive: true });

  // ── 1. generate JWT keys first (needed for JWKS setup) ──

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
  log.success("keys generated");

  // ── 2. neon database + data API ──

  let databaseUrl = "";
  let neonDataApi = "";
  let neonProjectId = "";

  if (await hasCommand("neonctl")) {
    // check auth
    const { exitCode } = await exec(["neonctl", "me"], { silent: true });
    if (exitCode !== 0) {
      log.info("authenticating with neon...");
      await execOrDie(["neonctl", "auth"]);
    }

    // create neon project
    log.info("creating neon database...");
    const { stdout: projectJson } = await execOrDie(["neonctl", "projects", "create", "--name", name, "--output", "json"]);
    const project = JSON.parse(projectJson);
    neonProjectId = project.project?.id || project.id;
    log.success(`neon project: ${neonProjectId}`);

    // get connection string (direct, not pooler)
    const { stdout: connStr } = await execOrDie(["neonctl", "connection-string", "--project-id", neonProjectId]);
    databaseUrl = connStr.trim();
    log.success("connection string ready");

    // get branch ID for data API setup
    const { stdout: branchJson } = await execOrDie(["neonctl", "branches", "list", "--project-id", neonProjectId, "--output", "json"]);
    const branches = JSON.parse(branchJson);
    const branchId = branches[0]?.id || branches.branches?.[0]?.id;

    if (branchId) {
      // get neon API token from neonctl credentials
      const neonToken = getNeonToken();

      if (neonToken) {
        // wait for endpoint to be ready, then enable Data API
        log.info("enabling data API (waiting for endpoint)...");
        for (let attempt = 0; attempt < 10; attempt++) {
          const dataApiRes = await fetch(
            `https://console.neon.tech/api/v2/projects/${neonProjectId}/branches/${branchId}/data-api/neondb`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${neonToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                auth_provider: "external",
                jwks_url: `https://${domain}/.well-known/jwks.json`,
                provider_name: "upend",
                add_default_grants: true,
                skip_auth_schema: true,
                settings: {
                  db_schemas: ["public"],
                  jwt_role_claim_key: ".role",
                },
              }),
            }
          );

          if (dataApiRes.ok) {
            const dataApi = await dataApiRes.json() as any;
            neonDataApi = dataApi.url || "";
            log.success(`data API: ${neonDataApi}`);
            break;
          }

          const err = await dataApiRes.text();
          if (err.includes("initializing") && attempt < 9) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          log.warn(`data API setup failed: ${err}`);
          log.dim("you can enable it manually in the Neon console");
          break;
        }

        // JWKS registration requires the URL to be reachable — defer to post-deploy
        log.dim(`JWKS will be registered after deploy (${domain} must be live)`);
        log.dim("run: upend setup:jwks  (after first deploy)");
      } else {
        log.warn("couldn't read neon API token — data API needs manual setup");
      }
    }
  } else {
    log.warn("neonctl not found — install with: npm i -g neonctl");
    log.dim("then re-run: upend init " + name);
    log.dim("or set DATABASE_URL manually in .env");
  }

  // ── 3. scaffold project files ──

  log.info("scaffolding project...");

  // resolve @upend/cli dependency
  const cliPkgPath = new URL("../../package.json", import.meta.url).pathname;
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"));
  const cliRoot = join(cliPkgPath, "..");
  const cliDep = cliPkg.version === "0.1.0" ? `file:${cliRoot}` : `^${cliPkg.version}`;

  writeFile(projectDir, "upend.config.ts", `import { defineConfig } from "@upend/cli";

export default defineConfig({
  name: "${name}",
  database: process.env.DATABASE_URL,
  dataApi: process.env.NEON_DATA_API,
  deploy: {
    host: process.env.DEPLOY_HOST,
    dir: "/opt/upend",
  },
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
      "@upend/cli": cliDep,
    },
  }, null, 2) + "\n");

  writeFile(projectDir, ".env", `DATABASE_URL="${databaseUrl}"
NEON_DATA_API="${neonDataApi}"
NEON_PROJECT_ID="${neonProjectId}"
ANTHROPIC_API_KEY=
DEPLOY_HOST=
API_PORT=3001
CLAUDE_PORT=3002
`);

  writeFile(projectDir, ".env.example", `DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
NEON_DATA_API=https://xxx.data-api.neon.tech
ANTHROPIC_API_KEY=sk-ant-...
DEPLOY_HOST=ec2-user@x.x.x.x
`);

  writeFile(projectDir, ".gitignore", `node_modules/
.env
.env.keys
.keys/
.snapshots/
sessions/
*.log
.DS_Store
`);

  // migrations
  mkdirSync(join(projectDir, "migrations"), { recursive: true });
  writeFile(projectDir, "migrations/001_init.sql", `-- your first migration
CREATE TABLE IF NOT EXISTS example (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
`);

  // apps + services
  mkdirSync(join(projectDir, "apps"), { recursive: true });
  writeFile(projectDir, "apps/.gitkeep", "");
  mkdirSync(join(projectDir, "services"), { recursive: true });
  writeFile(projectDir, "services/.gitkeep", "");

  // CLAUDE.md
  writeFile(projectDir, "CLAUDE.md", `# ${name}

You have FULL control of this codebase. Edit anything. Run anything. Create migrations. You are the developer.

Changes take effect immediately (Bun --watch). A snapshot was taken before you started — if something breaks, the user can rollback.

## Stack
- **Runtime**: Bun
- **Framework**: Hono
- **Database**: Neon Postgres (connection in node_modules/@upend/cli)
- **Auth**: Custom JWT (RS256)
- **Domain**: ${domain}

## What you can do
- Edit any file in the project
- Create new files, migrations, apps
- Run \`upend migrate\` to apply database migrations
- Create apps in \`apps/\` that are instantly served at \`/apps/<name>/\`

## Data API
Apps talk to Neon Data API at \`/api/data/<table>\`:
- GET \`/api/data/example?order=created_at.desc\` — list rows
- POST \`/api/data/example\` — create (JSON body, \`Prefer: return=representation\`)
- PATCH \`/api/data/example?id=eq.5\` — update
- DELETE \`/api/data/example?id=eq.5\` — delete
All requests need \`Authorization: Bearer <jwt>\` header.

## Conventions
- Migrations: plain SQL in \`migrations/\`, numbered \`001_name.sql\`
- Apps: static HTML/JS/CSS in \`apps/<name>/\`
- Custom services: \`services/<name>/index.ts\`
`);

  log.success("project scaffolded");

  // ── 4. encrypt .env ──

  if (databaseUrl) {
    log.info("encrypting .env...");
    await exec(["bunx", "@dotenvx/dotenvx", "encrypt"], { cwd: projectDir });
    log.success(".env encrypted");
  }

  // ── 5. git init ──

  log.info("initializing git...");
  await execOrDie(["git", "init"], { cwd: projectDir });
  await execOrDie(["git", "add", "-A"], { cwd: projectDir });
  await execOrDie(["git", "commit", "-m", "initial commit"], { cwd: projectDir });
  log.success("git initialized");

  // ── 6. install deps ──

  log.info("installing dependencies...");
  await execOrDie(["bun", "install"], { cwd: projectDir });
  log.success("dependencies installed");

  // ── done ──

  log.blank();
  log.header(`${name} is ready`);
  log.blank();
  log.info(`cd ${name}`);
  if (!databaseUrl) {
    log.info("# add your DATABASE_URL to .env");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log.info("# add your ANTHROPIC_API_KEY to .env");
  }
  log.info("upend dev");
  log.blank();
  if (databaseUrl) {
    log.dim(`database:  ${neonProjectId}`);
    if (neonDataApi) log.dim(`data API:  ${neonDataApi}`);
    log.dim(`JWKS:      https://${domain}/.well-known/jwks.json`);
    log.dim(`deploy:    upend infra:aws && upend deploy`);
  }
  log.blank();
}

// ── helpers ──

function getNeonToken(): string | null {
  const paths = [
    join(process.env.HOME || "", ".config/neonctl/credentials.json"),
    join(process.env.HOME || "", "Library/Application Support/neonctl/credentials.json"),
  ];
  for (const p of paths) {
    try {
      const creds = JSON.parse(readFileSync(p, "utf-8"));
      return creds.access_token || null;
    } catch {}
  }
  return null;
}

function writeFile(dir: string, path: string, content: string) {
  const fullPath = join(dir, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content);
}

async function exportKeyToPem(key: CryptoKey, type: "PRIVATE" | "PUBLIC") {
  const format = type === "PRIVATE" ? "pkcs8" : "spki";
  const exported = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(exported).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${type} KEY-----\n${lines}\n-----END ${type} KEY-----\n`;
}
