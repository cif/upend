import { log } from "../lib/log";
import { exec, execOrDie, hasCommand } from "../lib/exec";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";

export default async function init(args: string[]) {
  const name = args[0];
  if (!name) {
    log.error("usage: upend init <name> [--admin-email <email> --admin-password <pass>]");
    log.dim("  e.g. upend init beta → deploys to beta.upend.site");
    process.exit(1);
  }

  // parse optional flags
  const adminEmail = getFlag(args, "--admin-email");
  const adminPassword = getFlag(args, "--admin-password");

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

  if (!(await hasCommand("neonctl"))) {
    log.error("neonctl is required — install with: npm i -g neonctl");
    log.dim("upend currently requires Neon Postgres. More database support coming soon.");
    rmSync(projectDir, { recursive: true, force: true });
    process.exit(1);
  }

  {
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
  }

  // ── 3. scaffold project files ──

  log.info("scaffolding project...");

  // resolve @upend/cli version from our own package.json
  const cliPkgPath = new URL("../../package.json", import.meta.url).pathname;
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"));
  const cliDep = `^${cliPkg.version}`;

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
SIGNUP_ENABLED=false
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
  writeFile(projectDir, "migrations/001_users.sql", `-- users table (exposed via Data API)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
`);

  // apps + services
  mkdirSync(join(projectDir, "apps"), { recursive: true });
  // copy built-in users app
  const usersAppSrc = new URL("../apps/users/index.html", import.meta.url).pathname;
  mkdirSync(join(projectDir, "apps/users"), { recursive: true });
  writeFileSync(join(projectDir, "apps/users/index.html"), readFileSync(usersAppSrc, "utf-8"));
  mkdirSync(join(projectDir, "services"), { recursive: true });
  writeFile(projectDir, "services/.gitkeep", "");

  // tasks
  mkdirSync(join(projectDir, "tasks"), { recursive: true });
  writeFile(projectDir, "tasks/example.ts", `// example task — runs on a schedule or manually
// @cron 0 */6 * * *
// @description clean up ended sessions older than 7 days

import postgres from "postgres";
import { notify } from "@upend/cli/src/lib/notify";

const sql = postgres(process.env.DATABASE_URL!);

export async function run() {
  const deleted = await sql\`
    DELETE FROM upend.editing_sessions
    WHERE status = 'ended' AND created_at < now() - interval '7 days'
    RETURNING id
  \`;
  const msg = \`cleaned up \${deleted.length} old sessions\`;
  console.log(msg);

  if (deleted.length > 0) {
    await notify({ slack: "#tasks", text: msg });
  }
}

// run directly: bun tasks/example.ts
run().then(() => process.exit(0));
`);

  // claude skills
  const skillsDir = new URL("../skills", import.meta.url).pathname;
  mkdirSync(join(projectDir, ".claude/commands"), { recursive: true });
  for (const skill of ["diagnose.md", "aws.md", "deploy.md", "register.md"]) {
    writeFileSync(
      join(projectDir, `.claude/commands/${skill}`),
      readFileSync(join(skillsDir, skill), "utf-8")
    );
  }

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

## Access control
Apps read JWT claims to decide what to show:
\`\`\`js
const token = localStorage.getItem('upend_token');
const claims = JSON.parse(atob(token.split('.')[1]));
const isAdmin = claims.app_role === 'admin';
const myId = claims.sub;
\`\`\`

The data API at \`/api/data/:table\` sets JWT claims as Postgres session variables before each query,
so RLS policies have access to the current user.

When the user asks for access control, create RLS policies in a migration:
\`\`\`sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- everyone can read
CREATE POLICY "read" ON projects FOR SELECT USING (true);

-- users can only update their own rows
CREATE POLICY "update_own" ON projects FOR UPDATE
  USING (owner_id = current_setting('request.jwt.sub')::uuid);

-- only admins can delete
CREATE POLICY "admin_delete" ON projects FOR DELETE
  USING (current_setting('request.jwt.role') = 'admin');
\`\`\`

Available session variables in RLS policies:
- \`current_setting('request.jwt.sub')\` — user ID
- \`current_setting('request.jwt.role')\` — user role (admin/user)
- \`current_setting('request.jwt.email')\` — user email

The dashboard data tab shows active RLS policies per table so users can see what rules are in place.
The \`apps/users/\` app is an example of the access control pattern.

## Notifications
Send email and Slack notifications from tasks or services:
\`\`\`ts
import { notify } from "@upend/cli/src/lib/notify";

// email
await notify({ email: "ben@example.com", subject: "Job done", body: "Cleaned up 5 sessions" });

// slack (channel name — requires SLACK_BOT_TOKEN)
await notify({ slack: "#tasks", text: "session cleanup complete" });

// slack (webhook URL — no token needed)
await notify({ slack: "https://hooks.slack.com/services/xxx", text: "done" });

// both at once
await notify({ email: "ben@example.com", slack: "#ops", subject: "Alert", body: "something happened" });
\`\`\`

Env vars: \`RESEND_API_KEY\` for email, \`SLACK_BOT_TOKEN\` or webhook URL for Slack.

## Conventions
- Migrations: plain SQL in \`migrations/\`, numbered \`001_name.sql\`
- Apps: static HTML/JS/CSS in \`apps/<name>/\`
- Custom services: \`services/<name>/index.ts\`
- Tasks: \`tasks/<name>.ts\` with \`@cron\` and \`@description\` comments
`);

  log.success("project scaffolded");

  // .env is plain text, gitignored — Bun auto-loads it

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

  // ── 7. bootstrap DB + create admin ──

  if (databaseUrl) {
    // run migrations (bootstrap + user's 001_init.sql which creates users table)
    log.info("running migrations...");
    await exec(["bunx", "upend", "migrate"], { cwd: projectDir });
    log.success("database ready");

    // prompt: create admin or enable signup?
    log.blank();
    process.stdout.write("  create an admin user now? (Y/n): ");
    const answer = (await readLine()).trim().toLowerCase();

    if (answer === "n" || answer === "no") {
      // enable signup so they can create accounts from the dashboard
      log.info("enabling public signup...");
      await setEnvVar(projectDir, "SIGNUP_ENABLED", "true");
      log.success("signup enabled — anyone can create an account");
    } else {
      // create admin user
      let email = adminEmail;
      let password = adminPassword;

      if (!email) {
        process.stdout.write("  admin email: ");
        email = (await readLine()).trim();
      }
      if (!password) {
        process.stdout.write("  admin password: ");
        password = (await readLine()).trim();
      }

      if (email && password) {
        log.info("creating admin user...");
        const postgres = (await import("postgres")).default;
        const sql = postgres(databaseUrl, { max: 1 });
        const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
        try {
          const [user] = await sql`
            INSERT INTO users (email, password_hash, role)
            VALUES (${email}, ${passwordHash}, 'admin')
            RETURNING id, email, role
          `;
          log.success(`admin: ${user.email}`);
        } catch (err: any) {
          if (err.code === "23505") {
            log.warn("admin user already exists");
          } else {
            log.warn(`could not create admin: ${err.message}`);
          }
        }
        await sql.end();
      }
    }
  }

  // ── done ──

  log.blank();
  log.header(`${name} is ready`);
  log.blank();
  log.info(`cd ${name}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    log.info("bunx upend env:set ANTHROPIC_API_KEY <your-key>");
  }
  log.info("bunx upend migrate");
  log.info("bunx upend dev");
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

async function setEnvVar(projectDir: string, key: string, value: string) {
  const envFile = readFileSync(join(projectDir, ".env"), "utf-8");
  const regex = new RegExp(`^${key}=.*$`, "m");
  const updated = regex.test(envFile)
    ? envFile.replace(regex, `${key}=${value}`)
    : envFile.trimEnd() + `\n${key}=${value}\n`;
  writeFileSync(join(projectDir, ".env"), updated);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf-8");
    stdin.once("data", (data: string) => {
      stdin.pause();
      resolve(data);
    });
  });
}

async function exportKeyToPem(key: CryptoKey, type: "PRIVATE" | "PUBLIC") {
  const format = type === "PRIVATE" ? "pkcs8" : "spki";
  const exported = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(exported).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${type} KEY-----\n${lines}\n-----END ${type} KEY-----\n`;
}
