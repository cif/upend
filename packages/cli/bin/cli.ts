#!/usr/bin/env bun

import { existsSync } from "fs";

// auto-load encrypted .env if present (skip for init — no .env yet)
const args = process.argv.slice(2);
const command = args[0];
if (command !== "init" && existsSync(".env")) {
  try {
    const { config } = await import("@dotenvx/dotenvx");
    config({ quiet: true });
  } catch {
    // dotenvx not available, env vars must be set manually
  }
}

const commands: Record<string, () => Promise<void>> = {
  init: () => import("../src/commands/init").then((m) => m.default(args.slice(1))),
  dev: () => import("../src/commands/dev").then((m) => m.default(args.slice(1))),
  deploy: () => import("../src/commands/deploy").then((m) => m.default(args.slice(1))),
  migrate: () => import("../src/commands/migrate").then((m) => m.default(args.slice(1))),
  infra: () => import("../src/commands/infra").then((m) => m.default(args.slice(1))),
  env: () => import("../src/commands/env").then((m) => m.default(args.slice(1))),
  workflows: () => import("../src/commands/workflows").then((m) => m.default(args.slice(1))),
  logs: () => import("../src/commands/logs").then((m) => m.default(args.slice(1))),
  status: () => import("../src/commands/status").then((m) => m.default(args.slice(1))),
  ssh: () => import("../src/commands/ssh").then((m) => m.default(args.slice(1))),
};

if (!command || command === "--help" || command === "-h") {
  console.log(`
  upend — anti-SaaS stack

  usage:
    upend init <name>        scaffold a new project
    upend dev                start local dev (services + caddy)
    upend deploy             deploy to remote instance
    upend migrate            run database migrations
    upend env:set <K> <V>    set an env var (decrypts, sets, re-encrypts)
    upend workflows          list workflows
    upend workflows run <n>  run a workflow manually
    upend workflows install  install cron schedules
    upend logs [service]     tail remote logs (api|claude|caddy|all)
    upend logs -f            follow logs in realtime
    upend status             check remote service health
    upend ssh [cmd]          SSH into remote (or run a command)
    upend infra:aws          provision AWS infrastructure

  options:
    --help, -h               show this help
    --version, -v            show version
`);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  console.log(pkg.version);
  process.exit(0);
}

// handle colon syntax: infra:aws, env:set
const cmd = command.startsWith("infra:") ? "infra" : command.startsWith("env:") ? "env" : command;

if (!commands[cmd]) {
  console.error(`unknown command: ${command}`);
  console.error(`run 'upend --help' for usage`);
  process.exit(1);
}

await commands[cmd]();
