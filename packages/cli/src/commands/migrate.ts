import { log } from "../lib/log";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

// bootstrap SQL lives in the package — framework tables
const bootstrapPath = new URL("../lib/bootstrap.sql", import.meta.url).pathname;

export default async function migrate(args: string[]) {
  const projectDir = resolve(".");
  const migrationsDir = join(projectDir, "migrations");

  log.header("running migrations");

  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });

  try {
    // 1. bootstrap framework tables (idempotent)
    log.info("bootstrapping framework tables...");
    const bootstrap = readFileSync(bootstrapPath, "utf-8");
    await sql.unsafe(bootstrap);
    log.success("framework tables ready");

    // 2. run user migrations
    const ran = new Set(
      (await sql`SELECT name FROM _migrations`).map((r: any) => r.name)
    );

    let files: string[];
    try {
      files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    } catch {
      log.warn("no migrations directory found");
      await sql.end();
      return;
    }

    let count = 0;
    for (const file of files) {
      if (ran.has(file)) continue;
      log.info(`running: ${file}`);
      const content = readFileSync(join(migrationsDir, file), "utf-8");
      await sql.unsafe(content);
      await sql`INSERT INTO _migrations (name) VALUES (${file})`;
      log.success(file);
      count++;
    }

    if (count === 0) {
      log.info("no new migrations");
    } else {
      log.success(`${count} migration(s) applied`);
    }

    await sql.end();
  } catch (err: any) {
    log.error(`migration failed: ${err.message}`);
    await sql.end();
    process.exit(1);
  }
}
