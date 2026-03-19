import { log } from "../lib/log";
import { exec } from "../lib/exec";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

type Task = {
  name: string;
  file: string;
  cron: string | null;
  description: string;
  installed: boolean;
};

export default async function tasks(args: string[]) {
  const sub = args[0];
  const projectDir = resolve(".");
  const tasksDir = join(projectDir, "tasks");

  switch (sub) {
    case "list":
    case undefined:
      await list(tasksDir);
      break;
    case "run":
      await run(tasksDir, args[1]);
      break;
    case "install":
      await install(tasksDir);
      break;
    case "uninstall":
      await uninstall();
      break;
    default:
      // treat it as a task name to run
      await run(tasksDir, sub);
  }
}

function parseTasks(dir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
  } catch {
    return [];
  }

  return files.map(file => {
    const content = readFileSync(join(dir, file), "utf-8");
    const cronMatch = content.match(/\/\/\s*@cron\s+(.+)/);
    const descMatch = content.match(/\/\/\s*@description\s+(.+)/);
    const cron = cronMatch ? cronMatch[1].trim() : null;
    const description = descMatch ? descMatch[1].trim() : "";
    const name = file.replace(/\.(ts|js)$/, "");
    return { name, file, cron, description, installed: false };
  });
}

async function getCrontab(): Promise<string> {
  const { stdout } = await exec(["crontab", "-l"], { silent: true });
  return stdout;
}

async function list(dir: string) {
  const wfs = parseTasks(dir);
  if (wfs.length === 0) {
    log.info("no tasks found in tasks/");
    return;
  }

  const crontab = await getCrontab();

  log.header("tasks");
  for (const wf of wfs) {
    const installed = crontab.includes(`tasks/${wf.file}`);
    const status = installed ? "installed" : wf.cron ? "not installed" : "manual only";
    const statusColor = installed ? "\x1b[32m" : "\x1b[90m";
    console.log(`  ${wf.name}`);
    if (wf.description) console.log(`    ${wf.description}`);
    if (wf.cron) console.log(`    cron: ${wf.cron}  [${statusColor}${status}\x1b[0m]`);
    else console.log(`    [manual only]`);
    console.log();
  }
}

async function run(dir: string, name?: string) {
  if (!name) {
    log.error("usage: upend tasks run <name>");
    process.exit(1);
  }

  const file = name.endsWith(".ts") || name.endsWith(".js") ? name : `${name}.ts`;
  const path = join(dir, file);

  log.info(`running ${file}...`);
  const { stdout, stderr, exitCode } = await exec(["bun", path]);
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);

  if (exitCode === 0) {
    log.success(`${file} complete`);
  } else {
    log.error(`${file} failed (exit ${exitCode})`);
  }
}

async function install(dir: string) {
  const wfs = parseTasks(dir).filter(w => w.cron);
  if (wfs.length === 0) {
    log.info("no tasks with @cron found");
    return;
  }

  const crontab = await getCrontab();
  const lines = crontab.split("\n").filter(l => !l.includes("# upend-task:"));
  const projectDir = resolve(".");

  for (const wf of wfs) {
    lines.push(`${wf.cron} cd ${projectDir} && bun tasks/${wf.file} >> /tmp/upend-task-${wf.name}.log 2>&1 # upend-task: ${wf.name}`);
    log.info(`installing ${wf.name}: ${wf.cron}`);
  }

  const newCrontab = lines.filter(Boolean).join("\n") + "\n";
  const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
  proc.stdin.write(newCrontab);
  proc.stdin.end();
  await proc.exited;

  log.success(`${wfs.length} task(s) installed`);
}

async function uninstall() {
  const crontab = await getCrontab();
  const lines = crontab.split("\n").filter(l => !l.includes("# upend-task:"));
  const newCrontab = lines.filter(Boolean).join("\n") + "\n";

  const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
  proc.stdin.write(newCrontab);
  proc.stdin.end();
  await proc.exited;

  log.success("all upend tasks removed from crontab");
}
