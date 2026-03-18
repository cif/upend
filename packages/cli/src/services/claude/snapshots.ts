import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const SNAPSHOTS_DIR = ".snapshots";

function snapshotsPath(projectRoot: string) {
  return join(projectRoot, SNAPSHOTS_DIR);
}

// create a timestamped snapshot of files + database
export async function snapshot(projectRoot: string): Promise<string> {
  const dir = snapshotsPath(projectRoot);
  mkdirSync(dir, { recursive: true });

  const name = `snap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dest = join(dir, name);
  mkdirSync(dest, { recursive: true });

  // 1. snapshot files
  const rsync = Bun.spawn(
    [
      "rsync", "-a",
      "--exclude", SNAPSHOTS_DIR,
      "--exclude", "node_modules",
      "--exclude", ".env.keys",
      `${projectRoot}/`,
      `${dest}/files/`,
    ],
    { stdout: "inherit", stderr: "inherit" }
  );
  const rsyncExit = await rsync.exited;
  if (rsyncExit !== 0) throw new Error(`file snapshot failed`);

  // 2. snapshot database via pg_dump (non-fatal if pg_dump is missing)
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    try {
    const dumpFile = join(dest, "db.sql");
    const pgDump = Bun.spawn(
      ["pg_dump", "--no-owner", "--no-privileges", dbUrl],
      { stdout: "pipe", stderr: "pipe" }
    );
    const dumpOutput = await new Response(pgDump.stdout).text();
    const dumpExit = await pgDump.exited;

    if (dumpExit === 0 && dumpOutput.length > 0) {
      writeFileSync(dumpFile, dumpOutput);
      console.log(`[snapshot] db dump: ${(dumpOutput.length / 1024).toFixed(1)}KB`);
    } else {
      const stderr = await new Response(pgDump.stderr).text();
      console.warn(`[snapshot] pg_dump failed (non-fatal): ${stderr}`);
    }
    } catch (err: any) {
      console.warn(`[snapshot] pg_dump unavailable (non-fatal): ${err.message}`);
    }
  }

  await pruneSnapshots(projectRoot, 10);
  console.log(`[snapshot] created ${name}`);
  return name;
}

// list available snapshots
export async function listSnapshots(projectRoot: string) {
  const dir = snapshotsPath(projectRoot);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.startsWith("snap-"))
    .map((name) => {
      const stat = statSync(join(dir, name));
      const hasDb = existsSync(join(dir, name, "db.sql"));
      return { name, created: stat.birthtime, hasDb };
    })
    .sort((a, b) => b.created.getTime() - a.created.getTime());
}

// restore a snapshot — files + optionally database
export async function restoreSnapshot(
  projectRoot: string,
  name: string,
  opts: { restoreDb?: boolean } = { restoreDb: true }
) {
  const snapDir = join(snapshotsPath(projectRoot), name);
  if (!existsSync(snapDir)) throw new Error(`snapshot '${name}' not found`);

  // 1. restore files
  const filesDir = join(snapDir, "files");
  if (existsSync(filesDir)) {
    const proc = Bun.spawn(
      [
        "rsync", "-a", "--delete",
        "--exclude", SNAPSHOTS_DIR,
        "--exclude", "node_modules",
        "--exclude", ".env.keys",
        "--exclude", ".env",
        `${filesDir}/`,
        `${projectRoot}/`,
      ],
      { stdout: "inherit", stderr: "inherit" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`file restore failed`);
    console.log(`[snapshot] files restored from ${name}`);
  }

  // 2. restore database
  const dumpFile = join(snapDir, "db.sql");
  if (opts.restoreDb && existsSync(dumpFile)) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL not set, cannot restore db");

    // drop and recreate all tables, then restore
    // psql with the dump file
    const proc = Bun.spawn(
      ["psql", dbUrl, "-f", dumpFile],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" },
      }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`db restore failed: ${stderr}`);
    }
    console.log(`[snapshot] db restored from ${name}`);
  }
}

async function pruneSnapshots(projectRoot: string, keep: number) {
  const snaps = await listSnapshots(projectRoot);
  for (const snap of snaps.slice(keep)) {
    const proc = Bun.spawn(
      ["rm", "-rf", join(snapshotsPath(projectRoot), snap.name)],
      { stdout: "inherit", stderr: "inherit" }
    );
    await proc.exited;
    console.log(`[snapshot] pruned ${snap.name}`);
  }
}
