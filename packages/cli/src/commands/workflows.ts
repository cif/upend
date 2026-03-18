import { log } from "../lib/log";
import { exec } from "../lib/exec";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

type Workflow = {
  name: string;
  file: string;
  cron: string | null;
  description: string;
  installed: boolean;
};

export default async function workflows(args: string[]) {
  const sub = args[0];
  const projectDir = resolve(".");
  const workflowsDir = join(projectDir, "workflows");

  switch (sub) {
    case "list":
    case undefined:
      await list(workflowsDir);
      break;
    case "run":
      await run(workflowsDir, args[1]);
      break;
    case "install":
      await install(workflowsDir);
      break;
    case "uninstall":
      await uninstall();
      break;
    default:
      // treat it as a workflow name to run
      await run(workflowsDir, sub);
  }
}

function parseWorkflows(dir: string): Workflow[] {
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
  const wfs = parseWorkflows(dir);
  if (wfs.length === 0) {
    log.info("no workflows found in workflows/");
    return;
  }

  const crontab = await getCrontab();

  log.header("workflows");
  for (const wf of wfs) {
    const installed = crontab.includes(`workflows/${wf.file}`);
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
    log.error("usage: upend workflows run <name>");
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
  const wfs = parseWorkflows(dir).filter(w => w.cron);
  if (wfs.length === 0) {
    log.info("no workflows with @cron found");
    return;
  }

  const crontab = await getCrontab();
  const lines = crontab.split("\n").filter(l => !l.includes("# upend-workflow:"));
  const projectDir = resolve(".");

  for (const wf of wfs) {
    lines.push(`${wf.cron} cd ${projectDir} && bun workflows/${wf.file} >> /tmp/upend-workflow-${wf.name}.log 2>&1 # upend-workflow: ${wf.name}`);
    log.info(`installing ${wf.name}: ${wf.cron}`);
  }

  const newCrontab = lines.filter(Boolean).join("\n") + "\n";
  const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
  proc.stdin.write(newCrontab);
  proc.stdin.end();
  await proc.exited;

  log.success(`${wfs.length} workflow(s) installed`);
}

async function uninstall() {
  const crontab = await getCrontab();
  const lines = crontab.split("\n").filter(l => !l.includes("# upend-workflow:"));
  const newCrontab = lines.filter(Boolean).join("\n") + "\n";

  const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
  proc.stdin.write(newCrontab);
  proc.stdin.end();
  await proc.exited;

  log.success("all upend workflows removed from crontab");
}
