import { log } from "../lib/log";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

export default async function migrate(args: string[]) {
  const projectDir = resolve(".");
  const migrationsDir = join(projectDir, "migrations");

  log.header("running migrations");

  // dynamic import postgres from the project's node_modules
  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });

  try {
    // ensure migrations table
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        ran_at TIMESTAMPTZ DEFAULT now()
      )
    `;

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
      process.exit(0);
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
