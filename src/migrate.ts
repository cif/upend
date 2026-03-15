import { sql } from "../lib/db";

// Dead simple migrations — just SQL files run in order.
// No migration framework, no rollback theater.
// If something breaks, fix it and push a new migration.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

async function migrate() {
  // ensure migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  const ran = new Set(
    (await sql`SELECT name FROM _migrations`).map((r) => r.name)
  );

  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    console.log("No migrations directory found. Skipping.");
    process.exit(0);
  }

  for (const file of files) {
    if (ran.has(file)) continue;
    console.log(`Running migration: ${file}`);
    const content = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
    console.log(`  ✓ ${file}`);
  }

  console.log("Migrations complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
